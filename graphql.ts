// graphql.ts — a small GraphQL implementation for exactly the documents the suite sends:
// Query.viewer / repository / node / __type, the repository/issue/pull-request fields the
// checks read, cursor pagination, and the five mutations. It is a parser plus a
// schema-driven executor over the same ForgeStore the REST and git handlers use, so every
// surface sees the same data. Unknown fields answer HTTP 200 with an errors array naming
// the field, the way GitHub does.

import type { ForgeStore, Issue, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'int', value: Number.parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] };

export interface Operation {
  kind: 'query' | 'mutation';
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      // Optional operation name.
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') this.next();
      // Optional variable definitions: ($x: Type = default, ...).
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, selections };
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema data
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

interface GqlCtx {
  store: ForgeStore;
  errors: Array<{ message: string }>;
}

type GqlNode = Record<string, unknown> & { __typename: string };

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __typename: issue.isPull ? 'PullRequest' : 'Issue', repo, issue };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

function issueConnection(ctx: GqlCtx, repo: Repo, args: ConnectionArgs): GqlNode {
  let issues = repo.issues.filter((issue) => !issue.isPull);
  if (args.states !== undefined) {
    const wanted = new Set(args.states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const direction = args.orderBy?.direction ?? 'DESC';
  issues = [...issues].sort((a, b) => {
    const bySeq = direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq;
    if (bySeq !== 0) return bySeq;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = decodeCursor(args.after);
    if (afterNumber !== null) {
      const index = issues.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function prConnection(ctx: GqlCtx, repo: Repo, args: ConnectionArgs): GqlNode {
  let pulls = repo.issues.filter((issue) => issue.isPull);
  if (args.states !== undefined) {
    const wanted = new Set(args.states.map((state) => state.toLowerCase()));
    pulls = pulls.filter((issue) => wanted.has(issue.state));
  }
  const direction = args.orderBy?.direction ?? 'DESC';
  pulls = [...pulls].sort((a, b) => {
    const bySeq = direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq;
    if (bySeq !== 0) return bySeq;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = decodeCursor(args.after);
    if (afterNumber !== null) {
      const index = pulls.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = pulls.slice(start, start + first);
  const hasNextPage = start + page.length < pulls.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveNode(ctx: GqlCtx, nodeId: string): GqlNode | null {
  const ref = ctx.store.resolveGlobalId(nodeId);
  if (ref === undefined) return null;
  const [owner, name] = ref.repoKey.split('/');
  const repo = ctx.store.getRepo(owner!, name!);
  if (repo === undefined) return null;
  if (ref.kind === 'repo') return { __typename: 'Repository', repo };
  const issue = ctx.store.findIssue(repo, ref.number);
  return issue === undefined ? null : issueNode(repo, issue);
}

function typeNode(name: string): GqlNode | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = TYPE_ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __typename: '__Type',
    name,
    fields: (fields ?? []).map((field) => ({ __typename: '__Field', name: field })),
    enumValues: (enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
  };
}

// ---------------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------------

type Resolver = (ctx: GqlCtx, parent: GqlNode, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => ({ __typename: 'User', login: ctx.store.viewer() }),
    repository: (ctx, _parent, args) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (ctx.store.viewerLogin !== '' && owner !== ctx.store.viewerLogin) return null;
      if (!ctx.store.isViewer(owner)) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : { __typename: 'Repository', repo };
    },
    node: (ctx, _parent, args) => resolveNode(ctx, args.id as string),
    __type: (_ctx, _parent, args) => typeNode(args.name as string),
    __schema: () => null,
  },
  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = args.input as Record<string, unknown>;
      const ref = ctx.store.resolveGlobalId(input.repositoryId as string);
      if (ref === undefined || ref.kind !== 'repo') throw new Error('repository not found');
      const [owner, name] = ref.repoKey.split('/');
      const repo = ctx.store.getRepo(owner!, name!);
      if (repo === undefined) throw new Error('repository not found');
      const issue = ctx.store.createIssue(repo, {
        title: input.title as string,
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = args.input as Record<string, unknown>;
      const ref = ctx.store.resolveGlobalId(input.issueId as string);
      if (ref === undefined || ref.kind !== 'issue') throw new Error('issue not found');
      const [owner, name] = ref.repoKey.split('/');
      const repo = ctx.store.getRepo(owner!, name!);
      const issue = repo === undefined ? undefined : ctx.store.findIssue(repo, ref.number);
      if (repo === undefined || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = ctx.store.nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = args.input as Record<string, unknown>;
      const ref = ctx.store.resolveGlobalId(input.repositoryId as string);
      if (ref === undefined || ref.kind !== 'repo') throw new Error('repository not found');
      const [owner, name] = ref.repoKey.split('/');
      const repo = ctx.store.getRepo(owner!, name!);
      if (repo === undefined) throw new Error('repository not found');
      const head = input.headRefName as string;
      const base = input.baseRefName as string;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`head branch '${head}' does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`base branch '${base}' does not exist`);
      const pr = ctx.store.createIssue(repo, {
        title: input.title as string,
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
        isPull: true,
        headRef: head,
        baseRef: base,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: issueNode(repo, pr) };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = args.input as Record<string, unknown>;
      const ref = ctx.store.resolveGlobalId(input.pullRequestId as string);
      if (ref === undefined || ref.kind !== 'issue') throw new Error('pull request not found');
      const [owner, name] = ref.repoKey.split('/');
      const repo = ctx.store.getRepo(owner!, name!);
      const pr = repo === undefined ? undefined : ctx.store.findIssue(repo, ref.number);
      if (repo === undefined || pr === undefined || !pr.isPull) throw new Error('pull request not found');
      if (pr.state === 'closed') throw new Error('pull request is already closed');
      const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch is missing');
      const analysis = ctx.store.mergeAnalysis(repo, headSha, baseSha);
      if (!analysis.ok) throw new Error(`Merge conflict in: ${analysis.conflicts.join(', ')}`);
      const mergeSha = ctx.store.createCommit(repo, {
        tree: analysis.tree,
        parents: [baseSha],
        message: `${pr.title} (#${pr.number})`,
      });
      repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = ctx.store.nowIso();
      pr.mergeCommitSha = mergeSha;
      pr.updatedAt = ctx.store.nowIso();
      return { __typename: 'MergePullRequestPayload', pullRequest: issueNode(repo, pr) };
    },
    addComment: (ctx, _parent, args) => {
      const input = args.input as Record<string, unknown>;
      const ref = ctx.store.resolveGlobalId(input.subjectId as string);
      if (ref === undefined || ref.kind !== 'issue') throw new Error('subject not found');
      const [owner, name] = ref.repoKey.split('/');
      const repo = ctx.store.getRepo(owner!, name!);
      const issue = repo === undefined ? undefined : ctx.store.findIssue(repo, ref.number);
      if (repo === undefined || issue === undefined) throw new Error('subject not found');
      const comment = ctx.store.addComment(repo, issue, input.body as string);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: comment.nodeId, body: comment.body },
        },
      };
    },
  },
  User: {
    login: (_ctx, parent) => parent.login as string,
  },
  Repository: {
    id: (ctx, parent) => ctx.store.repoNodeId(parent.repo as Repo),
    databaseId: (_ctx, parent) => (parent.repo as Repo).id,
    name: (_ctx, parent) => (parent.repo as Repo).name,
    nameWithOwner: (_ctx, parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    owner: (_ctx, parent) => ({ __typename: 'User', login: (parent.repo as Repo).owner }),
    defaultBranchRef: (_ctx, parent) => ({ __typename: 'BranchRef', name: (parent.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const issue = ctx.store.findIssue(repo, args.number as number);
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (ctx, parent, args) => issueConnection(ctx, parent.repo as Repo, args as ConnectionArgs),
    pullRequests: (ctx, parent, args) => prConnection(ctx, parent.repo as Repo, args as ConnectionArgs),
    pullRequest: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const issue = ctx.store.findIssue(repo, args.number as number);
      return issue === undefined || !issue.isPull ? null : issueNode(repo, issue);
    },
  },
  Issue: {
    id: (_ctx, parent) => (parent.issue as Issue).nodeId,
    number: (_ctx, parent) => (parent.issue as Issue).number,
    title: (_ctx, parent) => (parent.issue as Issue).title,
    state: (_ctx, parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (_ctx, parent) => (parent.issue as Issue).body,
  },
  PullRequest: {
    id: (_ctx, parent) => (parent.issue as Issue).nodeId,
    number: (_ctx, parent) => (parent.issue as Issue).number,
    title: (_ctx, parent) => (parent.issue as Issue).title,
    state: (_ctx, parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (_ctx, parent) => (parent.issue as Issue).merged,
    headRefName: (_ctx, parent) => (parent.issue as Issue).headRef,
    baseRefName: (_ctx, parent) => (parent.issue as Issue).baseRef,
    mergeable: (ctx, parent) => {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const headSha = repo.refs.get(`refs/heads/${issue.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${issue.baseRef}`);
      if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
      return ctx.store.hasMergeConflict(repo, headSha, baseSha) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (ctx, parent, args) => {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const headSha = repo.refs.get(`refs/heads/${issue.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${issue.baseRef}`);
      if (headSha === undefined || baseSha === undefined) return { __typename: 'PullRequestFileConnection', nodes: [] };
      const files = ctx.store.prFiles(repo, headSha, baseSha);
      const first = typeof args.first === 'number' ? args.first : 30;
      return {
        __typename: 'PullRequestFileConnection',
        nodes: files.slice(0, first).map((file) => ({ __typename: 'ChangedFile', path: file.filename })),
      };
    },
  },
  IssueConnection: {
    nodes: (_ctx, parent) => parent.nodes as GqlNode[],
    pageInfo: (_ctx, parent) => parent.pageInfo as GqlNode,
  },
  PullRequestConnection: {
    nodes: (_ctx, parent) => parent.nodes as GqlNode[],
    pageInfo: (_ctx, parent) => parent.pageInfo as GqlNode,
  },
  PullRequestFileConnection: {
    nodes: (_ctx, parent) => parent.nodes as GqlNode[],
  },
  PageInfo: {
    hasNextPage: (_ctx, parent) => parent.hasNextPage as boolean,
    endCursor: (_ctx, parent) => parent.endCursor as string | null,
  },
  BranchRef: {
    name: (_ctx, parent) => parent.name as string,
  },
  __Type: {
    name: (_ctx, parent) => parent.name as string,
    fields: (_ctx, parent) => parent.fields as GqlNode[],
    enumValues: (_ctx, parent) => parent.enumValues as GqlNode[],
  },
  __Field: {
    name: (_ctx, parent) => parent.name as string,
  },
  __EnumValue: {
    name: (_ctx, parent) => parent.name as string,
  },
  IssueComment: {
    id: (_ctx, parent) => parent.id as string,
    body: (_ctx, parent) => parent.body as string,
  },
  IssueCommentEdge: {
    node: (_ctx, parent) => parent.node as GqlNode,
  },
};

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

function executeSelections(
  ctx: GqlCtx,
  parent: GqlNode,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typename = parent.__typename;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === typename) {
        Object.assign(out, executeSelections(ctx, parent, selection.selection, variables));
      }
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
    const resolver = RESOLVERS[typename]?.[field.name];
    let value: unknown;
    if (resolver !== undefined) {
      try {
        value = resolver(ctx, parent, args);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[responseKey] = null;
        continue;
      }
    } else if (field.name in parent) {
      value = parent[field.name];
    } else {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
      out[responseKey] = null;
      continue;
    }
    if (field.selection !== undefined) {
      if (value === null || value === undefined) {
        out[responseKey] = null;
      } else if (Array.isArray(value)) {
        out[responseKey] = value.map((item) =>
          item !== null && typeof item === 'object' && '__typename' in item
            ? executeSelections(ctx, item as GqlNode, field.selection!, variables)
            : item,
        );
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[responseKey] = executeSelections(ctx, value as GqlNode, field.selection, variables);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

function executeDocument(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const errors: Array<{ message: string }> = [];
  const ctx: GqlCtx = { store, errors };
  try {
    const operation = new Parser(tokenize(query)).parseOperation();
    const root: GqlNode = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSelections(ctx, root, operation.selections, variables);
    return errors.length > 0 ? { data, errors } : { data };
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** Execute one GraphQL request body (a single document or a batch array). */
export function handleGraphQL(store: ForgeStore, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => {
      const doc = item as Record<string, unknown>;
      return executeDocument(store, String(doc.query ?? ''), (doc.variables as Record<string, unknown>) ?? {});
    });
  }
  const doc = body as Record<string, unknown>;
  return executeDocument(store, String(doc.query ?? ''), (doc.variables as Record<string, unknown>) ?? {});
}
