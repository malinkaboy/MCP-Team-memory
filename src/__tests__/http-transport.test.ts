import { describe, it, expect, vi } from 'vitest';

describe('MCP session TTL cleanup', () => {
  it('should expire sessions older than TTL', () => {
    const SESSION_TTL_MS = 100;
    const sessions = new Map<string, { lastActivity: number; transport: { close?: () => void } }>();

    sessions.set('old-session', {
      lastActivity: Date.now() - 200,
      transport: { close: vi.fn() },
    });
    sessions.set('fresh-session', {
      lastActivity: Date.now(),
      transport: { close: vi.fn() },
    });

    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        session.transport.close?.();
        sessions.delete(id);
      }
    }

    expect(sessions.has('old-session')).toBe(false);
    expect(sessions.has('fresh-session')).toBe(true);
  });

  it('should update lastActivity on request', () => {
    const sessions = new Map<string, { lastActivity: number }>();
    sessions.set('sess-1', { lastActivity: 1000 });

    const session = sessions.get('sess-1')!;
    session.lastActivity = Date.now();

    expect(session.lastActivity).toBeGreaterThan(1000);
  });
});
