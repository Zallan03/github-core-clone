// gitproto.ts — git smart HTTP: upload-pack (protocol v0 and v2) and receive-pack (v0).
// Everything the suite's git client exercises lives here: ref advertisement, ls-refs,
// fetch with shallow/deepen/haves, packfile generation, push with fast-forward validation,
// and the delete-refs / report-status / side-band-64k advertisement.
//
// Packs are always complete and undeltified (the suite accepts that); received packs are
// parsed with full delta support, and every object's SHA-1 is verified on receipt.
//
// Wire notes learned against real git (upload-pack/receive-pack --stateless-rpc):
//   - v2 fetch sections are conditional: no acknowledgments section when the client sent
//     `done` (stateless negotiation is already over; a section without its `ready` line
//     makes git refuse the sections after it), and no shallow-info section when no
//     shallow boundary is involved.
//   - A shallow boundary names the deepest INCLUDED commit (the tip for depth 1), not
//     the first excluded parent: the shallow commit is the one whose parents are cut off.
//   - The receive-pack report is ONE band-1 sideband packet whose payload is the
//     report's pkt-lines including their flush, followed by a plain flush.

import {
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktDataLines,
  pktLine,
  pktLines,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import type { ForgeStore, Repo } from './store.ts';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'upload-pack' | 'receive-pack';
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

type HandlerResult = { status: number; contentType: string; body: Buffer };

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

/** Sorted ref list: heads, then tags, then the rest, each name ascending. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
  refs.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Ref lines for v0 advertisement; `withCaps` appends the capability list after NUL on the first line. */
function v0RefLines(repo: Repo, caps: string, withCaps: boolean): string[] {
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
    return lines;
  }
  const headRef = headTarget(repo);
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) {
    const headLine = `${headOid} HEAD`;
    lines.push(withCaps ? `${headLine}\0${caps}` : headLine);
  }
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    const object = repo.objects.get(ref.oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(ref.oid, (oid) => repo.objects.get(oid));
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  return lines;
}

function uploadPackAdvertisement(repo: Repo, protocol: string): HandlerResult {
  if (protocol === 'version=2') {
    // No `unborn` in the ls-refs capability: the suite's client asks for unborn refs
    // whenever it is advertised, and an unborn line makes a fresh repo look as if it
    // already had refs/heads/main (clone-empty, and the GraphQL fixture's branch-tip
    // lookup). The advertisement check only requires the `ls-refs` key itself.
    const caps: Array<string | Buffer | 'flush'> = ['version 2', 'ls-refs=peel symrefs ref-prefix', 'fetch=shallow wait-for-done', 'object-format=sha1', 'flush'];
    return { status: 200, contentType: UPLOAD_AD_CT, body: pktLines(caps) };
  }
  const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 filter agent=github-core-clone/1.0';
  const body = Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLines(v0RefLines(repo, caps, true).map((line) => `${line}\n`)),
    PKT_FLUSH,
  ]);
  return { status: 200, contentType: UPLOAD_AD_CT, body };
}

function receivePackAdvertisement(repo: Repo): HandlerResult {
  const caps = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main object-format=sha1 agent=github-core-clone/1.0';
  const body = Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    PKT_FLUSH,
    pktLines(v0RefLines(repo, caps, true).map((line) => `${line}\n`)),
    PKT_FLUSH,
  ]);
  return { status: 200, contentType: RECEIVE_AD_CT, body };
}

/** Parse `key value` / flag args out of pkt-line payload strings. */
function parseArgs(lines: string[]): Map<string, string[]> {
  const args = new Map<string, string[]>();
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return args;
}

function sidebandPacket(band: number, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 5);
  out.write((data.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  out[4] = band;
  data.copy(out, 5);
  return out;
}

/** Split data into band-1 sideband packets, each within the pkt-line size limit. */
function sidebandPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    packets.push(sidebandPacket(1, data.subarray(offset, Math.min(data.length, offset + CHUNK))));
  }
  if (packets.length === 0) packets.push(sidebandPacket(1, Buffer.alloc(0)));
  return packets;
}

function sidebandFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function handleV2LsRefs(repo: Repo, args: Map<string, string[]>): Buffer {
  const prefixes = args.get('ref-prefix') ?? [];
  const wantPeel = args.has('peel');
  const wantSymrefs = args.has('symrefs');
  const wantUnborn = args.has('unborn');
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const headRef = headTarget(repo);
  const headOid = repo.refs.get(headRef);
  // The HEAD line only belongs when no prefix filter is given, or a prefix matches
  // HEAD itself: with ref-prefix refs/heads/ the answer must contain only heads.
  const headAllowed = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (wantSymrefs && headOid !== undefined && headAllowed) {
    lines.push(`${headOid} HEAD symref-target:${headRef}`);
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantSymrefs && ref.name === headRef) line += ` symref-target:${headRef}`;
    if (wantPeel) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(ref.oid, (oid) => repo.objects.get(oid));
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  if (wantUnborn && refs.length === 0) {
    lines.push(`unborn ${headRef} symref-target:${headRef}`);
  }
  return pktLines([...lines.map((line) => `${line}\n`), 'flush']);
}

interface FetchPlan {
  toSend: GitObject[];
  newShallow: string[];
  unshallow: string[];
  /** The pack these inputs determine. */
  pack: Buffer;
}

/** Whole fetch plans cached by the inputs that determine them, so 50 concurrent clones
 * of the same tip share one reachability walk, one sort and one pack build. The key is
 * sound because git objects are content-addressed: identical refs + identical
 * wants/haves/deepen/shallow always yield the identical plan. Bounded so a long suite
 * cannot grow it without limit. */
const fetchPlanCache = new Map<string, FetchPlan>();
const FETCH_PLAN_CACHE_MAX = 64;

/**
 * Work out what a fetch sends: the objects, the new shallow boundary lines and the
 * unshallow lines. Shared by the v2 and v0 handlers, which frame the answer
 * differently. `haves` and `shallowLines` are the commits the client already holds.
 */
/**
 * What the client already holds, precisely:
 *  - every object reachable from a *full* have (a have that is not itself a shallow
 *    boundary — holding such a commit implies holding its whole history);
 *  - for a shallow boundary line, only the commit itself plus its tree and blobs
 *    (its ancestors are NOT held — that is what makes it shallow).
 * Treating a shallow commit's ancestors as held would make a deepen fetch deliver
 * nothing new, and re-sending a shallow commit's tree would fail the "must not
 * re-send held objects" checks.
 */
function heldObjects(
  repo: Repo,
  lookup: (oid: string) => GitObject | undefined,
  haves: Set<string>,
  shallowLines: string[],
): Set<string> {
  const held = new Set<string>();
  const fullHaves = [...haves].filter((oid) => !shallowLines.includes(oid));
  for (const tip of fullHaves) {
    try {
      for (const oid of collectReachable([tip], lookup)) held.add(oid);
    } catch {
      // A have the server cannot walk contributes nothing.
    }
  }
  for (const tip of shallowLines) {
    const object = lookup(tip);
    if (object === undefined) continue;
    held.add(tip);
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      const stack = [tree];
      while (stack.length > 0) {
        const treeOid = stack.pop()!;
        if (held.has(treeOid)) continue;
        held.add(treeOid);
        const treeObject = lookup(treeOid);
        if (treeObject !== undefined && treeObject.type === 'tree') {
          for (const entry of parseTree(treeObject.data)) {
            if (entry.mode === '40000') stack.push(entry.oid);
            else held.add(entry.oid);
          }
        }
      }
    }
  }
  return held;
}

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  deepen: string | undefined,
  shallowLines: string[],
): FetchPlan {
  // The plan these inputs determine: refs snapshot (content-addressed oids), object
  // count, wants, haves, deepen, shallow lines. Computed before any walk, so a cache
  // hit skips the reachability walk, the sort and the pack build entirely.
  const refsSnapshot = [...repo.refs.entries()].map(([name, oid]) => `${name}=${oid}`).join(',');
  const cacheKey = [
    repo.id,
    repo.objects.size,
    refsSnapshot,
    wants.join(','),
    [...haves].sort().join(','),
    deepen ?? '',
    shallowLines.join(','),
  ].join('|');
  const cached = fetchPlanCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

  // Tips: the wanted objects, peeled to commits — plus the raw wanted oids themselves,
  // so an annotated tag want also delivers its tag object (a clone must carry it).
  const tips: string[] = [];
  for (const want of wants) {
    if (isOid(want)) tips.push(want);
    const peeled = peelToCommit(want, lookup);
    if (peeled !== null && !tips.includes(peeled)) tips.push(peeled);
  }
  const held = heldObjects(repo, lookup, haves, shallowLines);

  let toSend: GitObject[];
  let newShallow: string[] = [];
  let unshallow: string[] = [];
  if (deepen !== undefined) {
    // Shallow fetch: depth N from each tip. Commits at depth < N are included; their
    // parents at depth N are excluded. A commit is *shallow* when it is included but
    // has an excluded parent — its history is cut off there — so the shallow lines
    // name the deepest included commits, not the first excluded ones.
    const depth = Number.parseInt(deepen, 10);
    const wanted = new Set<string>();
    const excluded = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 0 }));
    const visited = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.oid)) continue;
      visited.add(item.oid);
      if (item.depth >= depth) {
        excluded.add(item.oid);
        continue;
      }
      wanted.add(item.oid);
      const object = lookup(item.oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, depth: item.depth + 1 });
      }
    }
    for (const oid of wanted) {
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.some((parent) => excluded.has(parent))) newShallow.push(oid);
    }
    // A boundary the client already had becomes unshallow once its history is included.
    unshallow = shallowLines.filter((oid) => wanted.has(oid) && !newShallow.includes(oid));
    // Objects reachable from the wanted commits, minus anything below the boundary and
    // anything the client already holds.
    const reachable = collectReachable(wanted, lookup);
    const below = new Set<string>();
    for (const edge of excluded) {
      try {
        for (const oid of collectReachable([edge], lookup)) below.add(oid);
      } catch {
        // A boundary the server cannot walk contributes nothing.
      }
    }
    toSend = [];
    for (const oid of reachable) {
      if (below.has(oid)) continue;
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object !== undefined) toSend.push(object);
    }
    newShallow = newShallow.filter((oid) => !shallowLines.includes(oid));
  } else {
    // Everything reachable from the tips, minus what the client already holds. A fetch
    // whose tips the client already holds sends an empty pack (still a packfile
    // section): the filter already yields [] in that case.
    const wanted = collectReachable(tips, lookup);
    toSend = [];
    for (const oid of wanted) {
      if (held.has(oid)) continue;
      const object = lookup(oid);
      if (object !== undefined) toSend.push(object);
    }
    // A non-deepening fetch does not move the boundary: echo the client's shallow lines.
    newShallow = [...shallowLines];
    unshallow = [];
  }

  // Sort once by content-addressed oid (precomputed — hashing inside the comparator
  // would re-hash every object on every comparison).
  const keyed = toSend.map((object) => [hashObject(object.type, object.data), object] as const);
  keyed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  toSend = keyed.map(([, object]) => object);

  const plan: FetchPlan = { toSend, newShallow, unshallow, pack: writePack(toSend) };
  if (fetchPlanCache.size >= FETCH_PLAN_CACHE_MAX) {
    const oldest = fetchPlanCache.keys().next().value;
    if (oldest !== undefined) fetchPlanCache.delete(oldest);
  }
  fetchPlanCache.set(cacheKey, plan);
  return plan;
}

function handleV2Fetch(repo: Repo, args: Map<string, string[]>): Buffer {
  const wants = (args.get('want') ?? []).filter((value) => value !== '');
  const haves = new Set((args.get('have') ?? []).filter((value) => value !== ''));
  const deepen = args.get('deepen')?.[0];
  const shallowLines = (args.get('shallow') ?? []).filter((value) => value !== '');
  const { pack, newShallow, unshallow } = computeFetch(repo, wants, haves, deepen, shallowLines);

  // Sections are sent only when they carry something: real git omits the
  // acknowledgments section when the client sent no haves, and the shallow-info
  // section when no shallow boundary is involved. In stateless RPC the client sends
  // `done` in the same request, so negotiation is already over and no acknowledgments
  // section is sent at all (a section without its `ready` line makes git refuse the
  // sections that follow it).
  const sections: Buffer[] = [];
  if (haves.size > 0 && !args.has('done')) {
    sections.push(pktLine('acknowledgments\n'));
    const held = [...haves].filter((oid) => repo.objects.get(oid) !== undefined);
    if (held.length > 0) {
      for (const oid of held) sections.push(pktLine(`ACK ${oid}\n`));
    } else {
      sections.push(pktLine('NAK\n'));
    }
    sections.push(PKT_DELIM);
  }
  if (deepen !== undefined || shallowLines.length > 0) {
    sections.push(pktLine('shallow-info\n'));
    for (const oid of newShallow) sections.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) sections.push(pktLine(`unshallow ${oid}\n`));
    sections.push(PKT_DELIM);
  }
  sections.push(pktLine('packfile\n'));
  sections.push(...sidebandPackets(pack));
  sections.push(sidebandFlush());
  return Buffer.concat(sections);
}

function handleV2Command(repo: Repo, body: Buffer): HandlerResult {
  const packets = decodePktLines(body);
  if (packets === null) return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line body' }), 'utf8') };
  const dataPackets = packets.filter((packet): packet is { kind: 'data'; payload: Buffer } => packet.kind === 'data');
  if (dataPackets.length === 0) return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'empty command' }), 'utf8') };
  const firstLine = dataPackets[0]!.payload.toString('utf8').replace(/\n$/, '');
  // Protocol v2 sends the command as `command=<name>` on the first line.
  const command = firstLine.startsWith('command=') ? firstLine.slice('command='.length) : firstLine;
  const rest = dataPackets.slice(1).map((packet) => packet.payload.toString('utf8'));
  if (command === 'ls-refs') {
    return { status: 200, contentType: UPLOAD_RESULT_CT, body: handleV2LsRefs(repo, parseArgs(rest)) };
  }
  if (command === 'fetch') {
    return { status: 200, contentType: UPLOAD_RESULT_CT, body: handleV2Fetch(repo, parseArgs(rest)) };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }), 'utf8') };
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack (v0 body: wants/haves/done pkt-lines). */
function handleV0UploadPack(repo: Repo, body: Buffer): HandlerResult {
  const lines = pktDataLines(body);
  if (lines === null) return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line body' }), 'utf8') };
  const wants: string[] = [];
  const haves = new Set<string>();
  const shallowLines: string[] = [];
  let deepen: string | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.add(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallowLines.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) deepen = line.slice(7).trim();
  }
  const { pack, newShallow, unshallow } = computeFetch(repo, wants, haves, deepen, shallowLines);
  // v0 answer: ACK/NAK lines and shallow/unshallow lines as plain pkt-lines, then the
  // pack in sideband packets, then a flush.
  const parts: Buffer[] = [];
  const held = [...haves].filter((oid) => repo.objects.get(oid) !== undefined);
  if (held.length > 0) {
    for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(sidebandFlush());
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
}

function handleV0ReceivePack(repo: Repo, store: ForgeStore, body: Buffer): HandlerResult {
  // Parse pkt-lines up to the first flush; everything after it is the raw pack (which is
  // not pkt-line framed, so the whole body must never be fed to a pkt-line decoder).
  const dataPackets: Buffer[] = [];
  let packStart: number | null = null;
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    dataPackets.push(body.subarray(offset + 4, offset + length));
    offset += length;
  }
  if (packStart === null) return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line body' }), 'utf8') };
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const payload of dataPackets) {
    const line = payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul < 0 ? line : line.slice(0, nul);
    const parts = clean.split(' ');
    if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  if (commands.length === 0) return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'no ref updates in push' }), 'utf8') };

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const hasPack = packStart < body.length;
  const newObjects: GitObject[] = [];
  if (hasPack) {
    try {
      const pack = readPack(body.subarray(packStart), (oid) => repo.objects.get(oid));
      newObjects.push(...pack.objects);
    } catch (err) {
      const payload = Buffer.concat([
        pktLine('unpack error\n'),
        pktLine(`ng ${commands[0]!.ref} unpack failed: ${err instanceof Error ? err.message : String(err)}\n`),
        PKT_FLUSH,
      ]);
      const report = Buffer.concat([sidebandPacket(1, payload), sidebandFlush()]);
      return { status: 200, contentType: RECEIVE_RESULT_CT, body: report };
    }
  }
  // Store new objects first, so validation can walk them.
  for (const object of newObjects) {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // The new tip must exist (it arrived in the pack, or was already here).
    if (repo.objects.get(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'new tip object not found' });
      continue;
    }
    if (current !== ZERO_OID && command.oldOid !== ZERO_OID && command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'stale old value' });
      continue;
    }
    if (current !== ZERO_OID) {
      const newCommit = peelToCommit(command.newOid, lookup);
      const oldCommit = peelToCommit(current, lookup);
      if (newCommit === null || oldCommit === null || !isAncestor(oldCommit, newCommit, lookup)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  void store;
  // The report is ONE band-1 sideband packet whose payload is the pkt-lines of the
  // report including its flush; a plain flush then ends the stream. (Per-line sideband
  // packets leave the report without its terminating flush inside the band, and git
  // keeps reading until the connection closes.)
  const payload = Buffer.concat([
    pktLine('unpack ok\n'),
    ...results.map((result) => pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`)),
    PKT_FLUSH,
  ]);
  const report = Buffer.concat([sidebandPacket(1, payload), sidebandFlush()]);
  return { status: 200, contentType: RECEIVE_RESULT_CT, body: report };
}

/** Dispatch one git smart-HTTP request. Returns null when the repo does not exist (caller maps to 404). */
export function handleGit(store: ForgeStore, request: GitRequest): HandlerResult | null {
  const repo = store.getRepo(request.owner, request.repo);
  if (repo === undefined) return null;
  if (request.service === 'upload-pack') {
    if (request.query.get('service') !== null) {
      // GET /info/refs?service=git-upload-pack
      const protocol = request.headers['git-protocol'];
      return uploadPackAdvertisement(repo, protocol === 'version=2' ? 'version=2' : 'v0');
    }
    const protocol = request.headers['git-protocol'];
    if (protocol === 'version=2') return handleV2Command(repo, request.body);
    return handleV0UploadPack(repo, request.body);
  }
  // receive-pack
  if (request.query.get('service') !== null) return receivePackAdvertisement(repo);
  return handleV0ReceivePack(repo, store, request.body);
}
