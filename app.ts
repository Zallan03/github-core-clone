// app.ts — the HTTP server: routing, auth, JSON parsing, and the X-GitHub-Request-Id
// every reply carries. Routes:
//
//   GET  /healthz                              -> {"ok": true} (no auth; the boot check)
//   POST /mcp                                  -> MCP JSON-RPC
//   POST /api/graphql                          -> GraphQL (single or batch)
//   /api/v3/*                                  -> REST v3
//   /{owner}/{repo}.git/info/refs?service=... -> git advertisement
//   POST /{owner}/{repo}.git/git-upload-pack   -> git fetch (v0/v2)
//   POST /{owner}/{repo}.git/git-receive-pack  -> git push (v0)
//
// Auth: every route except /healthz requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
// A missing or wrong token is 401 with a JSON message. A repo under another owner is 404,
// never 403 (enforced in the handlers).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

export function createApp(): Server {
  const store = new ForgeStore();
  let requestCounter = 0;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const method = req.method ?? 'GET';
      const path = url.pathname;
      const segments = path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));

      // GET /healthz — the boot check, no auth.
      if (path === '/healthz') {
        if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        return sendJson(res, 200, { ok: true }, requestId);
      }

      // Auth: Bearer $MAKEFUN_SHOP_TOKEN on everything else.
      const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      const auth = req.headers.authorization ?? '';
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const authorized = expectedToken === '' ? presented !== '' : presented === expectedToken;
      if (!authorized) {
        return sendJson(res, 401, { message: 'Bad credentials' }, requestId);
      }

      // POST /mcp — JSON-RPC; a non-JSON body is HTTP 400 with code -32700.
      if (path === '/mcp') {
        if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, requestId);
        }
        const result = handleMcp(store, parsed);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': requestId });
          return res.end();
        }
        return sendJson(res, result.status, result.body, requestId);
      }

      // POST /api/graphql — single document or a batch array.
      if (path === '/api/graphql') {
        if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
        }
        return sendJson(res, 200, handleGraphQL(store, parsed), requestId);
      }

      // /api/v3/* — REST.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        // GET and HEAD have no body; DELETE may carry one (delete contents sends message+sha).
        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        let parsed: unknown = undefined;
        if (raw.length > 0) {
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            return sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
          }
        }
        const result = handleRest(
          { store, host: req.headers.host ?? '127.0.0.1' },
          method,
          segments.slice(2),
          url.searchParams,
          parsed,
        );
        // GitHub answers every API call with its OAuth scopes.
        return sendJson(res, result.status, result.body, requestId, { 'x-oauth-scopes': 'repo, read:org', ...(result.headers ?? {}) });
      }

      // /{owner}/{repo}.git/* — git smart HTTP.
      if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
        const owner = segments[0]!;
        const repo = segments[1]!.slice(0, -4);
        if (!store.isViewer(owner)) {
          return sendJson(res, 404, { message: 'Not Found' }, requestId);
        }
        const tail = segments.slice(2);
        if (tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service === 'git-upload-pack' || service === 'git-receive-pack') {
            const result = handleGit(store, { owner, repo, service: service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack', query: url.searchParams, headers: req.headers as Record<string, string | undefined>, body: Buffer.alloc(0) });
            if (result === null) return sendJson(res, 404, { message: 'Not Found' }, requestId);
            return sendRaw(res, result.status, result.contentType, result.body, requestId);
          }
          return sendJson(res, 404, { message: 'Not Found' }, requestId);
        }
        if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
          const raw = await readBody(req);
          const result = handleGit(store, { owner, repo, service: 'upload-pack', query: url.searchParams, headers: req.headers as Record<string, string | undefined>, body: raw });
          if (result === null) return sendJson(res, 404, { message: 'Not Found' }, requestId);
          return sendRaw(res, result.status, result.contentType, result.body, requestId);
        }
        if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
          const raw = await readBody(req);
          const result = handleGit(store, { owner, repo, service: 'receive-pack', query: url.searchParams, headers: req.headers as Record<string, string | undefined>, body: raw });
          if (result === null) return sendJson(res, 404, { message: 'Not Found' }, requestId);
          return sendRaw(res, result.status, result.contentType, result.body, requestId);
        }
        return sendJson(res, 404, { message: 'Not Found' }, requestId);
      }

      return sendJson(res, 404, { message: 'Not Found' }, requestId);
    } catch (err) {
      process.stderr.write(`[app] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
      } else {
        res.destroy();
      }
    }
  });
}
