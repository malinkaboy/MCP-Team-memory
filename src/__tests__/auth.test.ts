import { describe, it, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { AgentInfo } from '../auth/agent-tokens.js';

// Minimal Express mock
function mockReq(headers: Record<string, string> = {}) {
  return { headers, path: '/api/memory' } as any;
}

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

describe('Auth middleware', () => {
  it('passes through when no token configured', () => {
    const middleware = createAuthMiddleware(undefined);
    const next = () => {};
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(200);
  });

  it('rejects request without token when token is configured', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    const next = () => {};
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toContain('required');
  });

  it('rejects request with wrong token', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    const next = () => {};
    const req = mockReq({ authorization: 'Bearer wrong-token' });
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('allows request with correct token', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq({ authorization: 'Bearer secret-token-123' });
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('skips auth for static files (no /api/ prefix)', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq();
    req.path = '/styles.css';
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });
});

describe('createAuthMiddleware edge cases', () => {
  it('treats empty string token as auth disabled (next() called)', () => {
    const middleware = createAuthMiddleware('');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('treats whitespace-only token as auth disabled (next() called)', () => {
    const middleware = createAuthMiddleware('   ');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('whitespace-trimmed token matches correctly', () => {
    const middleware = createAuthMiddleware('  secret-token-123  ');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq({ authorization: 'Bearer secret-token-123' });
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });
});

// Mock AgentTokenStore for testing
function createMockTokenStore(tokens: Record<string, AgentInfo>) {
  const trackCalls: string[] = [];
  return {
    resolve: (token: string) => tokens[token] || null,
    trackLastUsed: (id: string) => { trackCalls.push(id); },
    trackCalls,
  };
}

describe('Auth middleware with agent tokens', () => {
  it('resolves agent token and sets agentName/agentRole', () => {
    const store = createMockTokenStore({
      'tm_test123': { id: 'uuid-1', agentName: 'TestDev', role: 'developer', isActive: true },
    });
    const middleware = createAuthMiddleware('master-secret', store as any);
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq({ authorization: 'Bearer tm_test123' });
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
    expect(req.agentName).toBe('TestDev');
    expect(req.agentRole).toBe('developer');
  });

  it('tracks last used on agent token resolution', () => {
    const store = createMockTokenStore({
      'tm_track': { id: 'uuid-track', agentName: 'Tracker', role: 'qa', isActive: true },
    });
    const middleware = createAuthMiddleware('master-secret', store as any);
    const next = () => {};
    const req = mockReq({ authorization: 'Bearer tm_track' });
    const res = mockRes();

    middleware(req, res, next);
    expect(store.trackCalls).toContain('uuid-track');
  });

  it('master token bypasses agent store', () => {
    const store = createMockTokenStore({});
    const middleware = createAuthMiddleware('master-secret', store as any);
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq({ authorization: 'Bearer master-secret' });
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
    expect(req.agentName).toBeUndefined();
    expect((req as any).auth?.clientId).toBe('master');
  });

  it('unknown token rejected when agent store has no match', () => {
    const store = createMockTokenStore({});
    const middleware = createAuthMiddleware('master-secret', store as any);
    const next = () => {};
    const req = mockReq({ authorization: 'Bearer tm_unknown' });
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('sets auth scopes with agent role for MCP context', () => {
    const store = createMockTokenStore({
      'tm_lead': { id: 'uuid-lead', agentName: 'LeadUser', role: 'lead', isActive: true },
    });
    const middleware = createAuthMiddleware('master-secret', store as any);
    const next = () => {};
    const req = mockReq({ authorization: 'Bearer tm_lead' });
    const res = mockRes();

    middleware(req, res, next);
    expect((req as any).auth?.scopes).toEqual(['lead']);
  });
});
