// mcp.ts — the Model Context Protocol surface at /mcp (JSON-RPC 2.0 over Streamable HTTP).
// Both eras are implemented: the modern `server/discover` handshake and the legacy
// `initialize` + `notifications/initialized` pair. The six github-mcp-server tools act on
// the same ForgeStore as REST, so a repo created by a tool is visible to REST and git.
//
// The tools/list answer is built once and reused byte-identically; tool calls answer
// `{content: [{type: "text", text: <JSON>}], structuredContent: <object>}`.

import type { ForgeStore, Issue, Repo } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, "owner/repo".' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const DISCOVER_RESULT = {
  supportedVersions: ['2026-07-28', '2025-11-25'],
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
};

function repoJson(store: ForgeStore, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(store: ForgeStore, repo: Repo, issue: Issue): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
  if (issue.isPull) {
    out.head = { ref: issue.headRef, sha: repo.refs.get(`refs/heads/${issue.headRef}`) ?? null };
    out.base = { ref: issue.baseRef, sha: repo.refs.get(`refs/heads/${issue.baseRef}`) ?? null };
    out.merged = issue.merged;
    out.merged_at = issue.mergedAt;
    out.merge_commit_sha = issue.mergeCommitSha;
  }
  return out;
}

/** Split tool args into owner/repo, accepting either separate fields or full_name. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner === '' ? parts[0]! : owner;
      repo = repo === '' ? parts[1]! : repo;
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (repoName === '') return toolError('name is required');
      if (store.getRepo(store.viewer(), repoName) !== undefined) return toolError(`Repository '${repoName}' already exists`);
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('owner and repo are required');
      if (!store.isViewer(target.owner)) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('owner and repo are required');
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (title === '') return toolError('title is required');
      if (!store.isViewer(target.owner)) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const issue = store.createIssue(repo, { title, body: typeof args.body === 'string' ? args.body : '', labels: [] });
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('owner and repo are required');
      if (!store.isViewer(target.owner)) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult(issues.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('owner and repo are required');
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      if (!store.isViewer(target.owner)) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`head branch '${head}' does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`base branch '${base}' does not exist`);
      const pr = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
        isPull: true,
        headRef: head,
        baseRef: base,
      });
      return toolResult(issueJson(store, repo, pr));
    }
    case 'merge_pull_request': {
      const target = resolveOwnerRepo(args);
      if (target === null) return toolError('owner and repo are required');
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      if (!Number.isInteger(pullNumber)) return toolError('pull_number is required');
      if (!store.isViewer(target.owner)) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository '${target.owner}/${target.repo}' not found`);
      const pr = store.findIssue(repo, pullNumber);
      if (pr === undefined || !pr.isPull) return toolError(`Pull request #${pullNumber} not found`);
      if (pr.state === 'closed') return toolError('Pull request is already closed');
      const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (headSha === undefined || baseSha === undefined) return toolError('head or base branch is missing');
      const analysis = store.mergeAnalysis(repo, headSha, baseSha);
      if (!analysis.ok) return toolError(`Merge conflict in: ${analysis.conflicts.join(', ')}`);
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
      return toolResult({ sha: mergeSha, merged: true, message: 'Pull request successfully merged', number: pr.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/** Handle one JSON-RPC request object. Returns {status, body} (body null means 202, no body). */
export function handleMcp(store: ForgeStore, request: unknown): McpResult {
  const req = request as Record<string, unknown>;
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;

  const result = (value: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: value } });
  const error = (code: number, message: string): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } });

  // A notification (no id) is acknowledged with 202 and no body.
  if (id === undefined) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') return result(DISCOVER_RESULT);
  if (method === 'initialize') {
    return result({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    // Built once at module load and never mutated: byte-identical across calls.
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return error(-32602, `Unknown tool: ${toolName}`);
    }
    const tool = TOOLS.find((entry) => entry.name === toolName)!;
    for (const required of tool.inputSchema.required ?? []) {
      if (toolArgs[required] === undefined || toolArgs[required] === '') {
        return result({ content: [{ type: 'text', text: `Missing required argument: ${required}` }], isError: true });
      }
    }
    return result(callTool(store, toolName, toolArgs));
  }
  return error(-32601, `Method not found: ${method}`);
}
