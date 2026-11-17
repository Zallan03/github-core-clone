// store.ts — the forge's in-memory state: repositories, git objects and refs, issues and
// pull requests, labels, comments, and the opaque GraphQL ids. Nothing here touches disk;
// the whole forge lives in this one store, shared by the REST, GraphQL, MCP and git
// handlers so every surface sees the same data.
//
// Determinism: request handling never reads the wall clock or Math.random. Timestamps come
// from a fixed base (the competition open) plus a monotonic sequence, so two identical
// request streams produce identical records. The viewer login is learned from the first
// owner segment seen in a request path (the shop token does not encode it); repos created
// before it is learned, under the placeholder owner, are re-keyed once it is known.

import {
  buildCommit,
  buildTree,
  buildTag,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const DEFAULT_BRANCH = 'main';
export const BASE_TIMESTAMP = Math.floor(Date.parse('2026-11-14T00:00:00Z') / 1000);

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  isPull: boolean;
  // pull request fields
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  comments: Map<number, IssueComment[]>;
  nextIssueNumber: number;
  nextCommentId: number;
}

export type GlobalRef =
  | { kind: 'repo'; repoKey: string }
  | { kind: 'issue'; repoKey: string; number: number };

function opaqueId(kind: string, repoId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${number}`;
  return `${kind}_${Buffer.from(raw, 'utf8').toString('base64url')}`;
}

export function isoTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function isValidLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

export class ForgeStore {
  repos = new Map<string, Repo>();
  globalIds = new Map<string, GlobalRef>();
  viewerLogin = '';
  private nextRepoId = 1;
  private nextIssueId = 1;
  private seq = 0;

  /** The next logical second. Monotonic, so created_at values never go backwards. */
  nowSeconds(): number {
    this.seq += 1;
    return BASE_TIMESTAMP + this.seq;
  }

  /** The next logical ISO timestamp. */
  nowIso(): string {
    return isoTimestamp(this.nowSeconds());
  }

  viewer(): string {
    return this.viewerLogin === '' ? 'viewer' : this.viewerLogin;
  }

  /**
   * Learn the token owner's login from an owner segment seen in a request path. Re-keys any
   * repos created under the placeholder owner before it was known. Returns the learned login
   * (or the placeholder when the candidate is not a plausible login).
   */
  learnLogin(candidate: string): string {
    if (!isValidLogin(candidate)) return this.viewer();
    if (this.viewerLogin === candidate) return candidate;
    if (this.viewerLogin === '') {
      this.viewerLogin = candidate;
      // Re-key placeholder-owned repos under the real login, including the global
      // ids that reference them by repo key.
      for (const [key, repo] of [...this.repos.entries()]) {
        if (repo.owner === 'viewer') {
          repo.owner = candidate;
          this.repos.delete(key);
          const newKey = `${candidate}/${repo.name}`;
          this.repos.set(newKey, repo);
          for (const ref of this.globalIds.values()) {
            if (ref.repoKey === key) ref.repoKey = newKey;
          }
        }
      }
      return candidate;
    }
    return this.viewerLogin;
  }

  /** True when `owner` is the token owner's login (learning it first when still unknown). */
  isViewer(owner: string): boolean {
    if (this.viewerLogin === '') return isValidLogin(owner) ? this.learnLogin(owner) === owner : false;
    return owner === this.viewerLogin;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const owner = this.viewer();
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      comments: new Map(),
      nextIssueNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    const nodeId = opaqueId('Repository', repo.id);
    this.globalIds.set(nodeId, { kind: 'repo', repoKey: this.repoKey(owner, name) });
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  addObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  authorLine(): string {
    const login = this.viewer();
    return `${login} <${login}@example.invalid>`;
  }

  createCommit(
    repo: Repo,
    fields: { tree: string; parents: string[]; message: string },
  ): string {
    const timestamp = this.nowSeconds();
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      message: fields.message,
      author: this.authorLine(),
      committer: this.authorLine(),
      timestamp,
    });
    return this.addObject(repo, 'commit', data);
  }

  createTag(repo: Repo, fields: { object: string; type: string; tag: string; message: string }): string {
    const timestamp = this.nowSeconds();
    const data = buildTag({ ...fields, tagger: this.authorLine(), timestamp });
    return this.addObject(repo, 'tag', data);
  }

  /** The flat path -> blob/tree entry map of a commit's tree (recursive). */
  flatTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const flat = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return flat;
  }

  /** Build (and store) the nested tree objects for a flat path map. Returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, value] of flat.entries()) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: buildLevel(childPrefix) });
      }
      return this.addObject(repo, 'tree', buildTree(entries));
    };
    return buildLevel('');
  }

  /** The commit oid a ref peels to, or null. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return peelToCommit(oid, this.lookup(repo));
  }

  headCommit(repo: Repo, branch?: string): string | null {
    return this.refCommit(repo, `refs/heads/${branch ?? repo.defaultBranch}`);
  }

  /** Commits reachable from `tip`, newest first (parents walked in order). */
  commitsFrom(repo: Repo, tip: string, limit = 100): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      // Present the message with one trailing newline stripped, so it equals the
      // message as submitted (git stores it with a trailing newline).
      const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
      out.push({ sha: oid, message });
      // Push parents in reverse so the first parent is visited first.
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return out;
  }

  /** Read-only three-way conflict check (no objects written): true when the merge would conflict. */
  hasMergeConflict(repo: Repo, headSha: string, baseSha: string): boolean {
    const lookup = this.lookup(repo);
    const base = mergeBase(headSha, baseSha, lookup);
    const baseFlat = base === null ? new Map() : this.flatTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
    const headFlat = this.flatTree(repo, parseCommit(repo.objects.get(headSha)!.data).tree);
    const tipFlat = this.flatTree(repo, parseCommit(repo.objects.get(baseSha)!.data).tree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const inBase = baseFlat.get(path);
      const inHead = headFlat.get(path);
      const inTip = tipFlat.get(path);
      const headChanged = (inBase?.oid ?? null) !== (inHead?.oid ?? null);
      if (!headChanged) continue;
      const tipChanged = (inBase?.oid ?? null) !== (inTip?.oid ?? null);
      if (tipChanged) return true;
    }
    return false;
  }

  /** The three-way merge result for a pull request, or a conflict listing. */
  mergeAnalysis(
    repo: Repo,
    headSha: string,
    baseSha: string,
  ): { ok: true; tree: string; baseTipTree: string } | { ok: false; conflicts: string[] } {
    const lookup = this.lookup(repo);
    const base = mergeBase(headSha, baseSha, lookup);
    const baseTreeOid = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTreeOid = parseCommit(repo.objects.get(headSha)!.data).tree;
    const baseTipTreeOid = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const baseFlat = baseTreeOid === null ? new Map() : this.flatTree(repo, baseTreeOid);
    const headFlat = this.flatTree(repo, headTreeOid);
    const tipFlat = this.flatTree(repo, baseTipTreeOid);
    const conflicts: string[] = [];
    const merged = new Map<string, { oid: string; mode: string }>(tipFlat);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const inBase = baseFlat.get(path);
      const inHead = headFlat.get(path);
      const inTip = tipFlat.get(path);
      const headChanged = (inBase?.oid ?? null) !== (inHead?.oid ?? null);
      if (!headChanged) continue;
      const tipChanged = (inBase?.oid ?? null) !== (inTip?.oid ?? null);
      if (tipChanged) {
        conflicts.push(path);
        continue;
      }
      if (inHead === undefined) merged.delete(path);
      else merged.set(path, inHead);
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    const tree = this.buildTreeFromFlat(repo, merged);
    return { ok: true, tree, baseTipTree: baseTipTreeOid };
  }

  /** Line-level additions/deletions between two blobs (multiset difference). */
  static diffLines(before: Buffer, after: Buffer): { additions: number; deletions: number } {
    const beforeLines = before.toString('utf8').split('\n');
    const afterLines = after.toString('utf8').split('\n');
    // Drop the trailing empty element a final newline produces, so a file ending in \n
    // does not count an extra blank line.
    if (beforeLines[beforeLines.length - 1] === '') beforeLines.pop();
    if (afterLines[afterLines.length - 1] === '') afterLines.pop();
    const counts = new Map<string, number>();
    for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of afterLines) {
      const left = counts.get(line) ?? 0;
      if (left > 0) counts.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of counts.values()) deletions += left;
    return { additions, deletions };
  }

  /** The file list of a pull request: merge-base tree vs head tree. */
  prFiles(repo: Repo, headSha: string, baseSha: string): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const lookup = this.lookup(repo);
    const base = mergeBase(headSha, baseSha, lookup);
    const baseFlat = base === null ? new Map() : this.flatTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
    const headFlat = this.flatTree(repo, parseCommit(repo.objects.get(headSha)!.data).tree);
    const files: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const inBase = baseFlat.get(path);
      const inHead = headFlat.get(path);
      if (inBase === undefined && inHead !== undefined) {
        const blob = repo.objects.get(inHead.oid);
        const lines = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length - (blob.data.toString('utf8').endsWith('\n') ? 1 : 0);
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (inBase !== undefined && inHead === undefined) {
        const blob = repo.objects.get(inBase.oid);
        const lines = blob === undefined ? 0 : blob.data.toString('utf8').split('\n').length - (blob.data.toString('utf8').endsWith('\n') ? 1 : 0);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
        const before = repo.objects.get(inBase.oid)?.data ?? Buffer.alloc(0);
        const after = repo.objects.get(inHead.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = ForgeStore.diffLines(before, after);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(
    repo: Repo,
    fields: { title: string; body: string; labels: string[]; isPull?: boolean; headRef?: string; baseRef?: string },
  ): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      number: repo.nextIssueNumber,
      id: this.nextIssueId,
      nodeId: opaqueId('Issue', repo.id, repo.nextIssueNumber),
      title: fields.title,
      body: fields.body,
      state: 'open',
      labels: [...fields.labels],
      isPull: fields.isPull ?? false,
      headRef: fields.headRef ?? '',
      baseRef: fields.baseRef ?? '',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      seq: this.seq,
    };
    repo.nextIssueNumber += 1;
    this.nextIssueId += 1;
    repo.issues.push(issue);
    this.globalIds.set(issue.nodeId, { kind: 'issue', repoKey: this.repoKey(repo.owner, repo.name), number: issue.number });
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  resolveGlobalId(nodeId: string): GlobalRef | undefined {
    return this.globalIds.get(nodeId);
  }

  repoNodeId(repo: Repo): string {
    return opaqueId('Repository', repo.id);
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment: IssueComment = {
      id,
      nodeId: opaqueId('IssueComment', repo.id, id),
      body,
      userLogin: this.viewer(),
      createdAt: this.nowIso(),
    };
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    return comment;
  }
}

export { isAncestor, ZERO_OID };
