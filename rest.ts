// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, contents, issues,
// pull requests, labels, comments, refs and branches. Every reply is JSON and carries
// X-GitHub-Request-Id (added by app.ts); errors are JSON with a string `message`.
//
// Routing is table-driven on path segments; auth (401) and the foreign-owner 404 are
// enforced here for /repos/{owner}/... paths. Pagination uses Link headers with absolute
// same-origin URLs, built from the request Host.

import { parseCommit } from './gitobj.ts';
import type { ForgeStore, Issue, Repo } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: ForgeStore;
  host: string;
}

const NOT_FOUND: RestResult = { status: 404, body: { message: 'Not Found' } };

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  if (value !== '' && !/^[A-Za-z0-9+/=_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Slice a list into a page and build the Link header (absolute, same-origin). */
function paginate<T>(ctx: RestContext, path: string, query: URLSearchParams, items: T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = parsePage(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const base = `http://${ctx.host}${path}`;
  const url = (p: number): string => `${base}?page=${p}&per_page=${perPage}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(totalPages)}>; rel="last"`);
  return { page: pageItems, headers: { Link: links.join(', ') } };
}

function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: ctx.store.repoNodeId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    topics: [],
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function branchRefJson(repo: Repo, branch: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${branch}`) ?? null;
  return {
    label: `${repo.owner}:${branch}`,
    ref: branch,
    sha,
    repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } },
  };
}

function prJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${issue.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${issue.baseRef}`) ?? null;
  let mergeable = true;
  if (headSha !== null && baseSha !== null) {
    mergeable = !ctx.store.hasMergeConflict(repo, headSha, baseSha);
  } else {
    mergeable = false;
  }
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    draft: false,
    user: { login: ctx.store.viewer() },
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${issue.number}`,
    head: branchRefJson(repo, issue.headRef),
    base: branchRefJson(repo, issue.baseRef),
    merged: issue.merged,
    mergeable,
    merged_at: issue.mergedAt,
    merge_commit_sha: issue.mergeCommitSha,
    merged_by: issue.merged ? { login: ctx.store.viewer() } : null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: ctx.store.viewer() },
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
  if (issue.isPull) {
    base.pull_request = {
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${issue.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${issue.number}`,
      merged_at: issue.mergedAt,
    };
  }
  return base;
}

function commentJson(ctx: RestContext, repo: Repo, issue: Issue, comment: { id: number; nodeId: string; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  void ctx;
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: comment.userLogin },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

/** Resolve /repos/{owner}/{name}; 404 when the owner is foreign or the repo is missing. */
function resolveRepo(ctx: RestContext, owner: string, name: string): { repo: Repo } | RestResult {
  if (!ctx.store.isViewer(owner)) return NOT_FOUND;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return NOT_FOUND;
  return { repo };
}

function isRestResult(value: { repo: Repo } | RestResult): value is RestResult {
  return 'status' in value;
}

/** The commit on a branch for contents reads/writes; null when the branch has no commits yet. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const store = ctx.store;
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return { status: 200, body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' } };
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return { status: 200, body: { verifiable_password_authentication: true, installed_version: '1.0.0', hooks: [], git: [], pages: [] } };
  }

  // /api/v3/user...
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      return { status: 200, body: { login: store.viewer(), id: 1, node_id: 'MDQ6VXNlcjE=', type: 'User' } };
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = [...store.repos.values()].sort((a, c) => a.id - c.id);
        const { page, headers } = paginate(ctx, '/api/v3/user/repos', query, repos);
        return { status: 200, body: page.map((repo) => repoJson(ctx, repo)), headers };
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
        if (store.getRepo(store.viewer(), name) !== undefined) {
          return { status: 422, body: { message: 'Repository already exists.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
        }
        const repo = store.createRepo(name, typeof b.description === 'string' ? b.description : '', b.private === true);
        return { status: 201, body: repoJson(ctx, repo) };
      }
      return err(405, 'Method Not Allowed');
    }
    return NOT_FOUND;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments[0] === 'repos') {
    if (segments.length < 3) return NOT_FOUND;
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    const resolved = resolveRepo(ctx, owner, name);
    if (isRestResult(resolved)) return resolved;
    const repo = resolved.repo;

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(ctx, repo) };
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.default_branch === 'string' && repo.refs.has(`refs/heads/${b.default_branch}`)) repo.defaultBranch = b.default_branch;
        repo.updatedAt = store.nowIso();
        return { status: 200, body: repoJson(ctx, repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(405, 'Method Not Allowed');
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      const branch = typeof query.get('ref') === 'string' ? query.get('ref')! : repo.defaultBranch;
      if (method === 'GET') {
        const tip = branchTip(repo, branch);
        if (tip === null) return NOT_FOUND;
        const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
        const flat = store.flatTree(repo, treeOid);
        if (path === '') {
          // Root directory listing.
          const seen = new Map<string, { type: 'file' | 'dir'; sha: string }>();
          for (const [filePath, value] of flat.entries()) {
            const first = filePath.split('/')[0]!;
            if (filePath.includes('/')) {
              if (!seen.has(first)) seen.set(first, { type: 'dir', sha: '' });
            } else {
              seen.set(first, { type: 'file', sha: value.oid });
            }
          }
          const entries = [...seen.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1)).map(([entryName, entry]) => ({
            type: entry.type,
            name: entryName,
            path: entryName,
            sha: entry.sha,
            size: entry.type === 'dir' ? 0 : (repo.objects.get(entry.sha)?.data.length ?? 0),
            url: `https://api.github.com/repos/${owner}/${name}/contents/${entryName}`,
            html_url: `https://github.com/${owner}/${name}/blob/${branch}/${entryName}`,
          }));
          return { status: 200, body: entries };
        }
        const file = flat.get(path);
        if (file !== undefined) {
          const blob = repo.objects.get(file.oid);
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              size: blob?.data.length ?? 0,
              name: path.split('/').pop(),
              path,
              content: blob?.data.toString('base64') ?? '',
              sha: file.oid,
              url: `https://api.github.com/repos/${owner}/${name}/contents/${path}`,
              html_url: `https://github.com/${owner}/${name}/blob/${branch}/${path}`,
            },
          };
        }
        // A directory: entries directly under it.
        const prefix = `${path}/`;
        const entries: Record<string, unknown>[] = [];
        const seen = new Map<string, { type: 'file' | 'dir'; sha: string }>();
        for (const [filePath, value] of flat.entries()) {
          if (!filePath.startsWith(prefix)) continue;
          const restPath = filePath.slice(prefix.length);
          const first = restPath.split('/')[0]!;
          if (restPath.includes('/')) {
            if (!seen.has(first)) seen.set(first, { type: 'dir', sha: '' });
          } else {
            seen.set(first, { type: 'file', sha: value.oid });
          }
        }
        for (const [entryName, entry] of [...seen.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
          entries.push({
            type: entry.type,
            name: entryName,
            path: `${path}/${entryName}`,
            sha: entry.sha,
            size: entry.type === 'dir' ? 0 : (repo.objects.get(entry.sha)?.data.length ?? 0),
            url: `https://api.github.com/repos/${owner}/${name}/contents/${path}/${entryName}`,
            html_url: `https://github.com/${owner}/${name}/blob/${branch}/${path}/${entryName}`,
          });
        }
        if (entries.length === 0) return NOT_FOUND;
        return { status: 200, body: entries };
      }
      if (method === 'PUT') {
        if (path === '') return err(422, 'path is required');
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const content = decodeBase64(b.content);
        if (content === null) return err(400, 'content must be base64');
        const requestedBranch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        let tip = branchTip(repo, requestedBranch);
        if (tip === null && requestedBranch !== repo.defaultBranch) {
          // A contents write to a nonexistent branch creates it at the default tip.
          const defaultTip = branchTip(repo, repo.defaultBranch);
          if (defaultTip !== null) {
            repo.refs.set(`refs/heads/${requestedBranch}`, defaultTip);
            tip = defaultTip;
          }
        }
        const flat = tip === null ? new Map<string, { oid: string; mode: string }>() : store.flatTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const existing = flat.get(path);
        const isUpdate = existing !== undefined;
        if (isUpdate) {
          if (typeof b.sha !== 'string' || b.sha !== existing.oid) return err(409, 'sha does not match the current file');
        } else if (typeof b.sha === 'string') {
          return err(422, 'sha does not match: the file does not exist');
        }
        const blobOid = store.addObject(repo, 'blob', content);
        flat.set(path, { oid: blobOid, mode: '100644' });
        const treeOid = store.buildTreeFromFlat(repo, flat);
        const commitSha = store.createCommit(repo, { tree: treeOid, parents: tip === null ? [] : [tip], message });
        repo.refs.set(`refs/heads/${requestedBranch}`, commitSha);
        repo.updatedAt = store.nowIso();
        return {
          status: isUpdate ? 200 : 201,
          body: {
            content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitSha, message, author: { name: store.viewer() }, committer: { name: store.viewer() } },
          },
        };
      }
      if (method === 'DELETE') {
        if (path === '') return err(422, 'path is required');
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const requestedBranch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
        const tip = branchTip(repo, requestedBranch);
        if (tip === null) return NOT_FOUND;
        const flat = store.flatTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const existing = flat.get(path);
        if (existing === undefined) return NOT_FOUND;
        if (typeof b.sha !== 'string' || b.sha !== existing.oid) return err(409, 'sha does not match the current file');
        flat.delete(path);
        const treeOid = store.buildTreeFromFlat(repo, flat);
        const commitSha = store.createCommit(repo, { tree: treeOid, parents: [tip], message });
        repo.refs.set(`refs/heads/${requestedBranch}`, commitSha);
        repo.updatedAt = store.nowIso();
        return { status: 200, body: { commit: { sha: commitSha, message } } };
      }
      return err(405, 'Method Not Allowed');
    }

    // /labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].map((label) => labelJson(label));
        return { status: 200, body: labels };
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const label = {
          name,
          color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed',
          description: typeof b.description === 'string' ? b.description : '',
        };
        repo.labels.set(name, label);
        return { status: 201, body: labelJson(label) };
      }
      return err(405, 'Method Not Allowed');
    }

    // /issues...
    if (rest[0] === 'issues') {
      const number = rest.length >= 2 ? Number.parseInt(rest[1]!, 10) : Number.NaN;
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          if (sort === 'created') {
            issues = [...issues].sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          }
          const { page, headers } = paginate(ctx, `/api/v3/repos/${owner}/${name}/issues`, query, issues);
          return { status: 200, body: page.map((issue) => issueJson(ctx, repo, issue)), headers };
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title.trim() : '';
          if (title === '') return err(422, 'title is required');
          const labels = Array.isArray(b.labels) ? b.labels.filter((label): label is string => typeof label === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
          }
          const issue = store.createIssue(repo, { title, body: typeof b.body === 'string' ? b.body : '', labels });
          return { status: 201, body: issueJson(ctx, repo, issue) };
        }
        return err(405, 'Method Not Allowed');
      }
      if (Number.isNaN(number)) return NOT_FOUND;
      const issue = store.findIssue(repo, number);
      if (issue === undefined) return NOT_FOUND;
      // /issues/{n}/comments
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          return { status: 200, body: comments.map((comment) => commentJson(ctx, repo, issue, comment)) };
        }
        if (method === 'POST') {
          const commentBody = typeof b.body === 'string' ? b.body : '';
          if (commentBody === '') return err(422, 'body is required');
          const comment = store.addComment(repo, issue, commentBody);
          return { status: 201, body: commentJson(ctx, repo, issue, comment) };
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: issueJson(ctx, repo, issue) };
        if (method === 'PATCH') {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const labels = b.labels.filter((label): label is string => typeof label === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.nowIso();
          return { status: 200, body: issueJson(ctx, repo, issue) };
        }
        return err(405, 'Method Not Allowed');
      }
      return NOT_FOUND;
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      const number = rest.length >= 2 ? Number.parseInt(rest[1]!, 10) : Number.NaN;
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const pulls = repo.issues.filter((issue) => issue.isPull && (state === 'all' || issue.state === state));
          const { page, headers } = paginate(ctx, `/api/v3/repos/${owner}/${name}/pulls`, query, pulls);
          return { status: 200, body: page.map((issue) => prJson(ctx, repo, issue)), headers };
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title.trim() : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : '';
          if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined) return err(422, `head branch '${head}' does not exist`);
          if (baseSha === undefined) return err(422, `base branch '${base}' does not exist`);
          const pr = store.createIssue(repo, {
            title,
            body: typeof b.body === 'string' ? b.body : '',
            labels: [],
            isPull: true,
            headRef: head,
            baseRef: base,
          });
          return { status: 201, body: prJson(ctx, repo, pr) };
        }
        return err(405, 'Method Not Allowed');
      }
      if (Number.isNaN(number)) return NOT_FOUND;
      const pr = store.findIssue(repo, number);
      if (pr === undefined || !pr.isPull) return NOT_FOUND;
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
        if (headSha === undefined || baseSha === undefined) return { status: 200, body: [] };
        return { status: 200, body: store.prFiles(repo, headSha, baseSha) };
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return err(405, 'Method Not Allowed');
        if (pr.state === 'closed') return err(405, 'Pull request is already closed');
        const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
        if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch is missing');
        const analysis = store.mergeAnalysis(repo, headSha, baseSha);
        if (!analysis.ok) return err(405, `Merge conflict in: ${analysis.conflicts.join(', ')}`);
        const mergeMethod = typeof b.merge_method === 'string' ? b.merge_method : 'squash';
        void mergeMethod;
        const mergeSha = store.createCommit(repo, {
          tree: analysis.tree,
          parents: [baseSha],
          message: `${pr.title} (#${pr.number})`,
        });
        repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = store.nowIso();
        pr.mergeCommitSha = mergeSha;
        pr.updatedAt = store.nowIso();
        return { status: 200, body: { sha: mergeSha, merged: true, message: 'Pull request successfully merged' } };
      }
      if (rest.length === 2) {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        return { status: 200, body: prJson(ctx, repo, pr) };
      }
      return NOT_FOUND;
    }

    // /git/refs...
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') {
          const ref = typeof b.ref === 'string' ? b.ref : '';
          const sha = typeof b.sha === 'string' ? b.sha : '';
          if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
          if (repo.objects.get(sha) === undefined) return err(422, `object '${sha}' does not exist`);
          if (repo.refs.has(ref)) return err(422, `Reference already exists: ${ref}`);
          repo.refs.set(ref, sha);
          return { status: 201, body: { ref, node_id: `MDM6UmVm${repo.id}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).map((part) => decodeURIComponent(part)).join('/');
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return NOT_FOUND;
        return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
      }
      return NOT_FOUND;
    }

    // /branches...
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, commit: { message: commitMessage(repo, sha) } }, protected: false }));
        const { page, headers } = paginate(ctx, `/api/v3/repos/${owner}/${name}/branches`, query, branches);
        return { status: 200, body: page, headers };
      }
      if (rest.length === 2) {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const branch = decodeURIComponent(rest[1]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return NOT_FOUND;
        return { status: 200, body: { name: branch, commit: { sha, commit: { message: commitMessage(repo, sha) } }, protected: false } };
      }
      return NOT_FOUND;
    }

    // /commits
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      const branch = typeof query.get('sha') === 'string' ? query.get('sha')! : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      if (tip === null) return { status: 200, body: [] };
      const commits = store.commitsFrom(repo, tip);
      const { page, headers } = paginate(ctx, `/api/v3/repos/${owner}/${name}/commits`, query, commits);
      return {
        status: 200,
        body: page.map((commit) => ({
          sha: commit.sha,
          commit: { message: commit.message, author: { name: store.viewer() }, committer: { name: store.viewer() } },
          author: { login: store.viewer() },
          committer: { login: store.viewer() },
        })),
        headers,
      };
    }

    return NOT_FOUND;
  }

  return NOT_FOUND;
}

function commitMessage(repo: Repo, sha: string): string {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return '';
  const message = parseCommit(object.data).message;
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}
