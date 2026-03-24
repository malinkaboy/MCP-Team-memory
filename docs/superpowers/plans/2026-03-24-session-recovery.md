# Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an MCP session expires (30-min TTL), automatically recover it so Claude Code tool calls don't permanently fail.

**Architecture:** Two-layer approach in `src/transport/http.ts`. Layer A returns HTTP 404 for expired sessions (MCP spec). Layer B transparently re-initializes if the client retries with the same expired session ID within 30 seconds. Synthetic init handshake uses mock Node.js req/res objects passed through the SDK's `handleRequest`.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport), vitest

**Spec:** `docs/superpowers/specs/2026-03-24-session-recovery-design.md`

**Important SDK detail:** `StreamableHTTPServerTransport.handleRequest(req, res, parsedBody)` is a thin wrapper that uses `@hono/node-server`'s `getRequestListener` to convert Node.js `IncomingMessage`/`ServerResponse` to Web Standard `Request`/`Response`. Mock objects must satisfy hono's expectations (see Task 4 for details).

---

### Task 1: Create test file and helper function `isInitializeRequest`

**Files:**
- Create: `src/transport/__tests__/http.test.ts`
- Modify: `src/transport/http.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/transport/__tests__/http.test.ts
import { describe, it, expect } from 'vitest';
import { isInitializeRequest } from '../http.js';

describe('isInitializeRequest', () => {
  it('returns true for initialize JSON-RPC request', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    };
    expect(isInitializeRequest(body)).toBe(true);
  });

  it('returns true for initialize in batched request', () => {
    const body = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    expect(isInitializeRequest(body)).toBe(true);
  });

  it('returns false for tool call', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_read' } };
    expect(isInitializeRequest(body)).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isInitializeRequest(null)).toBe(false);
    expect(isInitializeRequest(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: FAIL — `isInitializeRequest` is not exported

- [ ] **Step 3: Implement `isInitializeRequest` and export it**

Add to `src/transport/http.ts` before `mountMcpTransport`:

```typescript
/** Check if a JSON-RPC body contains an initialize request */
export function isInitializeRequest(body: unknown): boolean {
  if (body == null) return false;
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (msg: any) => msg && typeof msg === 'object' && msg.method === 'initialize',
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Commit**

```bash
cd d:/MCP/team-memory-mcp && git add src/transport/http.ts src/transport/__tests__/http.test.ts && git commit -m "feat: add isInitializeRequest helper for session recovery"
```

---

### Task 2: Add `recentlyExpired` map and cleanup

**Files:**
- Modify: `src/transport/http.ts`
- Modify: `src/transport/__tests__/http.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/transport/__tests__/http.test.ts` (note: ESM imports, no `require()`):

```typescript
import {
  isInitializeRequest,
  REINIT_WINDOW_MS,
  getRecentlyExpiredForTest,
  cleanupExpiredEntries,
} from '../http.js';

describe('recentlyExpired cleanup', () => {
  beforeEach(() => {
    getRecentlyExpiredForTest().clear();
  });

  it('entries older than REINIT_WINDOW_MS are removed during cleanup', () => {
    const map = getRecentlyExpiredForTest();
    map.set('old-session', Date.now() - REINIT_WINDOW_MS - 1000);
    map.set('fresh-session', Date.now());

    cleanupExpiredEntries();

    expect(map.has('old-session')).toBe(false);
    expect(map.has('fresh-session')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: FAIL — exports not found

- [ ] **Step 3: Implement data structures and cleanup**

Add to `src/transport/http.ts` after existing constants:

```typescript
export const REINIT_WINDOW_MS = 30_000; // 30 seconds to retry before transparent re-init
const recentlyExpired = new Map<string, number>(); // sessionId → timestamp of 404
const reinitInProgress = new Set<string>();

/** Exported for testing only */
export function getRecentlyExpiredForTest(): Map<string, number> {
  return recentlyExpired;
}

/** Exported for testing only */
export function getReinitInProgressForTest(): Set<string> {
  return reinitInProgress;
}

/** Remove stale entries from recentlyExpired map. Uses REINIT_WINDOW_MS, not SESSION_TTL_MS. */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [id, timestamp] of recentlyExpired) {
    if (now - timestamp > REINIT_WINDOW_MS) {
      recentlyExpired.delete(id);
    }
  }
}
```

Add `cleanupExpiredEntries()` call inside the existing `setInterval` cleanup block, after the session TTL loop:

```typescript
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of transports) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      try { session.transport.close?.(); } catch { /* ignore close errors */ }
      transports.delete(id);
      logger.info({ sessionId: id }, 'MCP session expired (TTL)');
    }
  }
  cleanupExpiredEntries(); // <-- ADD THIS LINE
}, CLEANUP_INTERVAL_MS).unref();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd d:/MCP/team-memory-mcp && git add src/transport/http.ts src/transport/__tests__/http.test.ts && git commit -m "feat: add recentlyExpired map and cleanup for session recovery"
```

---

### Task 3: Implement Layer A — HTTP 404 for expired sessions

**Files:**
- Modify: `src/transport/http.ts`
- Modify: `src/transport/__tests__/http.test.ts`

- [ ] **Step 1: Install supertest as dev dependency**

Run: `cd d:/MCP/team-memory-mcp && npm install --save-dev supertest @types/supertest`

- [ ] **Step 2: Write the failing test**

Add integration-style test to `src/transport/__tests__/http.test.ts`:

```typescript
import express from 'express';
import request from 'supertest';
import { mountMcpTransport, getRecentlyExpiredForTest } from '../http.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Note: This mock Server has no tool handlers registered.
// tools/list will return empty list but won't error.
// This is sufficient for testing session lifecycle (404, re-init).
function createMockMcpServer(): Server {
  return new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
}

describe('Layer A: 404 for expired sessions', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mountMcpTransport(app, createMockMcpServer);
    getRecentlyExpiredForTest().clear();
  });

  it('returns 404 with X-MCP-Session-Expired for tool call with unknown session ID', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'non-existent-session-id')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_read' } });

    expect(res.status).toBe(404);
    expect(res.headers['x-mcp-session-expired']).toBe('true');
    expect(res.body.error.message).toContain('Session expired');
  });

  it('adds expired session ID to recentlyExpired map', async () => {
    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('mcp-session-id', 'expired-session-123')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });

    expect(getRecentlyExpiredForTest().has('expired-session-123')).toBe(true);
  });

  it('allows initialize request with unknown session ID (creates new session)', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', 'old-session-id')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      });

    // Should NOT be 404 — initialize requests are allowed to create new sessions
    expect(res.status).not.toBe(404);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: FAIL — current code creates new session instead of returning 404

- [ ] **Step 4: Implement Layer A in POST /mcp handler**

Replace the POST handler logic in `src/transport/http.ts`. The new flow:

```typescript
app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // 1. Existing session — reuse
  if (sessionId && transports.has(sessionId)) {
    const session = transports.get(sessionId)!;
    session.lastActivity = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // 2. Unknown/expired session with non-initialize request
  if (sessionId && !transports.has(sessionId) && !isInitializeRequest(req.body)) {
    // Layer B check: if this session was recently 404'd, do transparent re-init (Task 4)
    if (recentlyExpired.has(sessionId) && Date.now() - recentlyExpired.get(sessionId)! < REINIT_WINDOW_MS) {
      // Layer B placeholder — returns 404 for now, will be replaced in Task 4
      // Do NOT update recentlyExpired timestamp — preserve original 404 time
      logger.info({ sessionId }, 'MCP session expired (retry within window), returning 404 (Layer B not yet wired)');
      res.status(404)
        .set('X-MCP-Session-Expired', 'true')
        .json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session expired or not found. Please re-initialize.' },
          id: null,
        });
      return;
    }

    // Layer A: first time seeing this expired session — return 404 and record
    recentlyExpired.set(sessionId, Date.now());
    logger.info({ sessionId }, 'MCP session expired, returning 404');
    res.status(404)
      .set('X-MCP-Session-Expired', 'true')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session expired or not found. Please re-initialize.' },
        id: null,
      });
    return;
  }

  // 3. New session (no session ID, or initialize request)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id: string) => {
      transports.set(id, { transport, lastActivity: Date.now() });
      logger.info({ sessionId: id }, 'MCP session created');
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      logger.info({ sessionId: transport.sessionId }, 'MCP session closed');
    }
  };

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);

  await transport.handleRequest(req, res, req.body);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd d:/MCP/team-memory-mcp && git add src/transport/http.ts src/transport/__tests__/http.test.ts package.json package-lock.json && git commit -m "feat: Layer A — return 404 for expired MCP sessions (spec compliant)"
```

---

### Task 4: Implement Layer B — Transparent re-initialization

**Files:**
- Modify: `src/transport/http.ts`
- Modify: `src/transport/__tests__/http.test.ts`

- [ ] **Step 1: Spike — validate mock objects work with hono's `getRequestListener`**

Before writing the full implementation, verify that our mock approach works. Create a temporary test:

```typescript
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import crypto from 'crypto';

describe('Mock object compatibility spike', () => {
  it('mock IncomingMessage + ServerResponse work with SDK handleRequest', async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const server = new Server(
      { name: 'spike-test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    await server.connect(transport);

    // Create mock req
    const mockReq = createMockReq({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });

    // Create mock res
    const mockRes = createMockRes();

    const initBody = {
      jsonrpc: '2.0',
      id: 'spike-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'spike', version: '1.0' },
      },
    };

    // This should NOT throw — if it does, our mocks are insufficient
    await transport.handleRequest(mockReq, mockRes, initBody);
    expect(transport.sessionId).toBeDefined();

    await server.close();
  });
});
```

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts -t "Mock object"`
Expected: PASS. If FAIL, adjust mock objects (add missing properties) until it passes. The hono adapter may require `res.getHeaders()`, `res.writableEnded`, `res.finished`, `res.socket`, or `res.write()` — add them as needed.

**Fallback if minimal mocks don't work:** Use `new http.ServerResponse(new http.IncomingMessage(new net.Socket()))` as the base for mock res, which provides a complete Node.js ServerResponse. This is heavier but guaranteed compatible.

- [ ] **Step 2: Write the failing tests for Layer B**

Add to `src/transport/__tests__/http.test.ts`:

```typescript
describe('Layer B: transparent re-init', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mountMcpTransport(app, createMockMcpServer);
    getRecentlyExpiredForTest().clear();
  });

  it('recovers session on second request with recently-expired session ID', async () => {
    const expiredId = 'expired-for-reinit';

    // First request — gets 404, session added to recentlyExpired
    const res1 = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res1.status).toBe(404);

    // Second request — should trigger transparent re-init
    const res2 = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    // Should succeed — not 404 or 500
    expect(res2.status).not.toBe(404);
    expect(res2.status).not.toBe(500);
    expect(res2.status).not.toBe(503);
    // New session ID should be in response headers
    expect(res2.headers['mcp-session-id']).toBeDefined();
    expect(res2.headers['mcp-session-id']).not.toBe(expiredId);
  });

  it('returns 503 if re-init is already in progress for same session', async () => {
    const { getReinitInProgressForTest } = await import('../http.js');
    const inProgress = getReinitInProgressForTest();
    const expiredId = 'concurrent-reinit';

    getRecentlyExpiredForTest().set(expiredId, Date.now());
    inProgress.add(expiredId);

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(503);
    inProgress.delete(expiredId);
  });

  it('returns 503 if createMcpServer throws during re-init', async () => {
    const failApp = express();
    failApp.use(express.json());
    const failingFactory = () => { throw new Error('Server creation failed'); };
    mountMcpTransport(failApp, failingFactory as any);

    const expiredId = 'fail-reinit';
    getRecentlyExpiredForTest().set(expiredId, Date.now());

    const res = await request(failApp)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('recovery failed');
  });

  it('verifies header rewriting — new session ID visible to SDK', async () => {
    const expiredId = 'header-rewrite-test';

    // Trigger 404 first
    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    // Trigger re-init — verify response has new session ID (proves headers were rewritten)
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const newId = res.headers['mcp-session-id'];
    expect(newId).toBeDefined();
    expect(newId).not.toBe(expiredId);
    // Verify the new session is registered in the transports map
    // (indirectly — a subsequent request with the new ID should work)
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: FAIL — Layer B not implemented yet (transparent re-init returns 404)

- [ ] **Step 4: Implement `createMockReq`, `createMockRes` helper functions**

Add to `src/transport/http.ts`:

```typescript
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';

const MCP_PROTOCOL_VERSION = '2025-03-26';

/**
 * Create a minimal mock IncomingMessage for SDK's handleRequest.
 * The hono adapter reads: method, url, headers, and the stream body.
 * Since we pass parsedBody separately, the stream can be empty.
 */
function createMockReq(headers: Record<string, string>): http.IncomingMessage {
  const socket = new net.Socket();
  const mock = new http.IncomingMessage(socket);
  mock.method = 'POST';
  mock.url = '/mcp';
  mock.headers = { ...headers };
  mock.complete = true;
  // Push EOF so the stream is readable but empty (body comes via parsedBody param)
  mock.push(null);
  return mock;
}

/**
 * Create a mock ServerResponse that captures output without sending to a client.
 * Uses a real http.ServerResponse for maximum hono compatibility.
 */
function createMockRes(): http.ServerResponse {
  const socket = new net.Socket();
  const mockReq = new http.IncomingMessage(socket);
  const res = new http.ServerResponse(mockReq);
  // Prevent actual socket writes — redirect to a PassThrough sink
  const sink = new PassThrough();
  sink.on('data', () => {}); // drain
  res.assignSocket(socket);
  return res;
}
```

- [ ] **Step 5: Implement `performTransparentReinit` function**

Add to `src/transport/http.ts`:

```typescript
/**
 * Perform transparent session re-initialization.
 * Creates a new transport, runs synthetic init handshake,
 * then forwards the original request.
 */
async function performTransparentReinit(
  req: Request,
  res: Response,
  createMcpServer: () => Server,
): Promise<void> {
  const oldSessionId = req.headers['mcp-session-id'] as string;

  // Create new transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id: string) => {
      transports.set(id, { transport, lastActivity: Date.now() });
      logger.info({ sessionId: id, oldSessionId }, 'MCP transparent re-init successful, new session');
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      logger.info({ sessionId: transport.sessionId }, 'MCP session closed');
    }
  };

  // Connect MCP server
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);

  // --- Step 1: Synthetic initialize handshake ---
  const initBody = {
    jsonrpc: '2.0' as const,
    id: `synthetic-init-${crypto.randomUUID()}`,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'recovered-client', version: '1.0.0' },
    },
  };

  const mockInitReq = createMockReq({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  });
  const mockInitRes = createMockRes();

  await transport.handleRequest(mockInitReq, mockInitRes, initBody);

  const newSessionId = transport.sessionId;
  if (!newSessionId) {
    throw new Error('Transport did not generate session ID after synthetic init');
  }

  // --- Step 2: Synthetic notifications/initialized ---
  const notifBody = { jsonrpc: '2.0' as const, method: 'notifications/initialized' };
  const mockNotifReq = createMockReq({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-session-id': newSessionId,
  });
  const mockNotifRes = createMockRes();

  await transport.handleRequest(mockNotifReq, mockNotifRes, notifBody);

  // --- Step 3: Forward original request with corrected headers ---
  req.headers['mcp-session-id'] = newSessionId;
  req.headers['mcp-protocol-version'] = MCP_PROTOCOL_VERSION;
  // Ensure Accept header is present (some clients may omit it on retries)
  if (!req.headers['accept']) {
    req.headers['accept'] = 'application/json, text/event-stream';
  }

  await transport.handleRequest(req, res, req.body);
}
```

- [ ] **Step 6: Wire Layer B into the POST handler**

Replace the Layer B placeholder in the POST handler (from Task 3). The `if (recentlyExpired.has(...))` block becomes:

```typescript
if (recentlyExpired.has(sessionId) && Date.now() - recentlyExpired.get(sessionId)! < REINIT_WINDOW_MS) {
  // Layer B: transparent re-init
  if (reinitInProgress.has(sessionId)) {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session recovery in progress. Please retry.' },
      id: null,
    });
    return;
  }

  reinitInProgress.add(sessionId);
  try {
    logger.info({ sessionId }, 'MCP transparent re-init started');
    await performTransparentReinit(req, res, createMcpServer);
    recentlyExpired.delete(sessionId);
  } catch (err) {
    logger.error({ sessionId, err }, 'MCP transparent re-init failed');
    recentlyExpired.delete(sessionId); // reset so next request gets fresh 404
    if (!res.headersSent) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session recovery failed. Please restart.' },
        id: null,
      });
    }
  } finally {
    reinitInProgress.delete(sessionId);
  }
  return;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/transport/__tests__/http.test.ts`
Expected: PASS — all tests including Layer B, spike, and createMcpServer failure

If the spike test from Step 1 fails (mock incompatibility with hono), adjust mock implementation before proceeding. Common fixes:
- Add `res.getHeaders()` method
- Add `res.writableEnded = false` property
- Use `Object.defineProperty` for `headersSent` getter
- If all else fails, use the real `http.ServerResponse` approach from Step 4

- [ ] **Step 8: Commit**

```bash
cd d:/MCP/team-memory-mcp && git add src/transport/http.ts src/transport/__tests__/http.test.ts && git commit -m "feat: Layer B — transparent re-init for expired MCP sessions"
```

---

### Task 5: Build and verify compilation

**Files:**
- None modified — validation only

- [ ] **Step 1: Run TypeScript compilation**

Run: `cd d:/MCP/team-memory-mcp && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Fix any type errors**

Address any compilation issues from the new imports (`http`, `net`, `PassThrough`) and mock types. The `createMockReq` and `createMockRes` return types use real Node.js types, so casting should be minimal.

- [ ] **Step 3: Run full test suite**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Build the project**

Run: `cd d:/MCP/team-memory-mcp && npm run build`
Expected: Build succeeds, dist/ updated

- [ ] **Step 5: Commit if any fixes were needed**

```bash
cd d:/MCP/team-memory-mcp && git add -A && git commit -m "fix: resolve type errors in session recovery implementation"
```

---

### Task 6: Manual smoke test

**Files:**
- None modified — testing only

- [ ] **Step 1: Start the server**

Run: `cd d:/MCP/team-memory-mcp && npm start`
Verify: Server starts on port 3846

- [ ] **Step 2: Test normal flow — initialize + tool call**

```bash
# Initialize
curl -X POST http://localhost:3846/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -i

# Note the mcp-session-id from response headers, then:
curl -X POST http://localhost:3846/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

Expected: 200 on init, 202 on notification

- [ ] **Step 3: Test Layer A — tool call with fake session ID**

```bash
curl -X POST http://localhost:3846/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: fake-expired-session" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  -i
```

Expected: HTTP 404 with `X-MCP-Session-Expired: true`

- [ ] **Step 4: Test Layer B — retry with same expired session**

```bash
# Same request again — should trigger transparent re-init
curl -X POST http://localhost:3846/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: fake-expired-session" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' \
  -i
```

Expected: 200 with `mcp-session-id` header containing a NEW session ID, and a valid tools/list response

- [ ] **Step 5: Check server logs**

Verify log entries:
- `MCP session expired, returning 404`
- `MCP transparent re-init started`
- `MCP transparent re-init successful, new session: <uuid>`
