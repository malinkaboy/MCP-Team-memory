import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  REINIT_WINDOW_MS,
  getRecentlyExpiredForTest,
  getReinitInProgressForTest,
  cleanupExpiredEntries,
  mountMcpTransport,
} from '../http.js';

// Mock MCP Server — no tool handlers, sufficient for session lifecycle tests
function createMockMcpServer(): Server {
  return new Server(
    { name: 'test-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
}

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

    expect(res.status).not.toBe(404);
  });
});

describe('Mock object compatibility spike', () => {
  it('Web Standard Request works with SDK _webStandardTransport directly', async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const server = new Server(
      { name: 'spike-test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    await server.connect(transport);

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

    // Access underlying Web Standard transport (bypasses hono Node.js adapter)
    const webTransport = (transport as any)._webStandardTransport;
    const webReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initBody),
    });

    const webRes = await webTransport.handleRequest(webReq, { parsedBody: initBody });
    expect(webRes.status).toBe(200);
    expect(transport.sessionId).toBeDefined();

    await server.close();
  });
});

describe('Layer B: transparent re-init', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mountMcpTransport(app, createMockMcpServer);
    getRecentlyExpiredForTest().clear();
    getReinitInProgressForTest().clear();
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

    expect(res2.status).not.toBe(404);
    expect(res2.status).not.toBe(500);
    expect(res2.status).not.toBe(503);
    expect(res2.headers['mcp-session-id']).toBeDefined();
    expect(res2.headers['mcp-session-id']).not.toBe(expiredId);
  });

  it('returns 503 if re-init is already in progress for same session', async () => {
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

  it('verifies header rewriting — new session ID visible in response', async () => {
    const expiredId = 'header-rewrite-test';

    // Trigger 404 first
    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    // Trigger re-init
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', expiredId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const newId = res.headers['mcp-session-id'];
    expect(newId).toBeDefined();
    expect(newId).not.toBe(expiredId);
  });
});
