import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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
