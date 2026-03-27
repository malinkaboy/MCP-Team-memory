import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncWebSocketServer } from '../sync/websocket.js';

// Minimal mock for MemoryManager
const mockManager = {
  subscribe: vi.fn(() => () => {}),
} as any;

function createServer(): SyncWebSocketServer {
  return new SyncWebSocketServer(mockManager);
}

function addMockClient(
  server: SyncWebSocketServer,
  overrides: { id: string; name: string; clientType?: 'agent' | 'ui'; projectId?: string }
): void {
  const clients = (server as any).clients as Map<string, any>;
  clients.set(overrides.id, {
    ws: { readyState: 1 }, // OPEN
    id: overrides.id,
    name: overrides.name,
    clientType: overrides.clientType || 'agent',
    projectId: overrides.projectId,
    connectedAt: new Date(),
  });
}

describe('Project-scoped connection filtering', () => {
  let server: SyncWebSocketServer;

  beforeEach(() => {
    server = createServer();
    addMockClient(server, { id: 'a1', name: 'Agent-1', clientType: 'agent', projectId: 'proj-A' });
    addMockClient(server, { id: 'a2', name: 'Agent-2', clientType: 'agent', projectId: 'proj-A' });
    addMockClient(server, { id: 'b1', name: 'Agent-3', clientType: 'agent', projectId: 'proj-B' });
    addMockClient(server, { id: 'u1', name: 'UI-1', clientType: 'ui', projectId: 'proj-A' });
    addMockClient(server, { id: 'g1', name: 'Global', clientType: 'agent' }); // no projectId
  });

  describe('getConnectedClientsInfo', () => {
    it('returns all clients when no projectId filter', () => {
      const result = server.getConnectedClientsInfo();
      expect(result).toHaveLength(5);
    });

    it('filters clients by projectId', () => {
      const result = server.getConnectedClientsInfo('proj-A');
      expect(result).toHaveLength(3); // a1, a2, u1
      expect(result.every(c => c.projectId === 'proj-A')).toBe(true);
    });

    it('returns only matching project clients', () => {
      const result = server.getConnectedClientsInfo('proj-B');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Agent-3');
    });

    it('returns empty array for unknown project', () => {
      const result = server.getConnectedClientsInfo('proj-unknown');
      expect(result).toHaveLength(0);
    });

    it('includes projectId in returned data', () => {
      const result = server.getConnectedClientsInfo('proj-A');
      expect(result[0].projectId).toBe('proj-A');
    });
  });

  describe('getConnectedCount', () => {
    it('returns total count when no projectId', () => {
      expect(server.getConnectedCount()).toBe(5);
    });

    it('counts only clients for specified project', () => {
      expect(server.getConnectedCount('proj-A')).toBe(3);
      expect(server.getConnectedCount('proj-B')).toBe(1);
    });

    it('returns 0 for unknown project', () => {
      expect(server.getConnectedCount('proj-unknown')).toBe(0);
    });
  });
});
