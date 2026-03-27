import { WebSocketServer, WebSocket } from 'ws';
import type http from 'http';
import crypto from 'crypto';
import type { MemoryManager } from '../memory/manager.js';
import type { WSEvent } from '../memory/types.js';
import type { AgentTokenStore } from '../auth/agent-tokens.js';
import logger from '../logger.js';

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  name: string;
  agentName?: string;  // Token-derived identity, immutable
  clientType: 'agent' | 'ui';
  projectId?: string;
  connectedAt: Date;
}

export class SyncWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private memoryManager: MemoryManager;
  private apiToken: string | undefined;
  private agentTokenStore?: AgentTokenStore;
  private unsubscribe: (() => void) | null = null;

  constructor(memoryManager: MemoryManager, apiToken?: string, agentTokenStore?: AgentTokenStore) {
    this.memoryManager = memoryManager;
    this.apiToken = apiToken;
    this.agentTokenStore = agentTokenStore;
  }

  /** Start WebSocket on a standalone port */
  start(port: number): void {
    this.wss = new WebSocketServer({ port });
    logger.info({ port }, 'WebSocket server started');
    this.setupConnectionHandler();
  }

  /** Attach WebSocket to an existing HTTP server (for unified mode) */
  attachToServer(server: http.Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    logger.info('WebSocket attached to HTTP server at /ws');
    this.setupConnectionHandler();
  }

  private setupConnectionHandler(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      // Verify token if auth is enabled
      const effectiveToken = this.apiToken?.trim();
      let resolvedAgentName: string | undefined;

      if (effectiveToken) {
        // SECURITY NOTE: query param token may leak to access logs, proxies, browser history.
        // Prefer Authorization: Bearer header. Query param kept for WebSocket clients that can't set headers.
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
        if (!token) {
          ws.close(4401, 'Unauthorized');
          return;
        }

        // Try agent token first
        const agentInfo = this.agentTokenStore?.resolve(token);
        if (agentInfo) {
          resolvedAgentName = agentInfo.agentName;
          this.agentTokenStore!.trackLastUsed(agentInfo.id);
        } else {
          // Fallback: master token (timing-safe)
          const tokenBuf = Buffer.from(token);
          const expectedBuf = Buffer.from(effectiveToken);
          if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
            ws.close(4401, 'Unauthorized');
            return;
          }
        }
      }

      const clientId = this.generateClientId();
      const clientType = url.searchParams.get('client_type') === 'ui' ? 'ui' as const : 'agent' as const;
      const projectId = url.searchParams.get('project_id') || undefined;
      const clientName = resolvedAgentName || req.headers['x-agent-name']?.toString() || (clientType === 'ui' ? `ui-${clientId.slice(0, 8)}` : `agent-${clientId.slice(0, 8)}`);

      const client: ConnectedClient = {
        ws,
        id: clientId,
        name: clientName,
        agentName: resolvedAgentName,
        clientType,
        projectId,
        connectedAt: new Date()
      };

      this.clients.set(clientId, client);
      logger.info({ clientName, clientId }, 'Client connected');

      this.sendToClient(ws, {
        type: 'agent:connected',
        payload: {
          clientId,
          clientName,
          projectId,
          connectedClients: this.getConnectedClientsInfo(projectId)
        },
        timestamp: new Date().toISOString()
      });

      this.broadcastExcept(clientId, {
        type: 'agent:connected',
        payload: { clientId, clientName, agentName: resolvedAgentName, projectId },
        timestamp: new Date().toISOString()
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(clientId, message);
        } catch (error) {
          logger.warn({ err: error }, 'Invalid message from client');
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info({ clientName, clientId, projectId }, 'Client disconnected');
        this.broadcast({
          type: 'agent:disconnected',
          payload: { clientId, clientName, projectId },
          timestamp: new Date().toISOString()
        });
      });

      ws.on('error', (error) => {
        logger.error({ clientName, err: error }, 'WebSocket error');
      });
    });

    this.unsubscribe = this.memoryManager.subscribe((event) => {
      this.broadcast(event);
    });
  }

  private handleClientMessage(clientId: string, message: unknown): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const msg = message as { type?: string; payload?: unknown };

    switch (msg.type) {
      case 'ping':
        this.sendToClient(client.ws, {
          type: 'memory:sync',
          payload: { pong: true },
          timestamp: new Date().toISOString()
        });
        break;

      case 'sync_request':
        this.handleSyncRequest(client, msg.payload as { since?: string })
          .catch(err => logger.error({ err }, 'Sync request error'));
        break;

      case 'rename': {
        // Token-authenticated agents have immutable names — ignore rename attempts
        if (client.agentName) break;
        const rawName = (msg.payload as { name?: string })?.name;
        // Sanitize: limit length, strip HTML-unsafe chars to prevent XSS in broadcast/UI
        const newName = rawName?.slice(0, 64).replace(/[<>"'&]/g, '').trim();
        if (newName) {
          client.name = newName;
          this.broadcast({
            type: 'agent:connected',
            payload: { clientId, clientName: newName, projectId: client.projectId, renamed: true },
            timestamp: new Date().toISOString()
          });
        }
        break;
      }

      default:
        logger.warn({ clientName: client.name, messageType: msg.type }, 'Unknown message type');
    }
  }

  private async handleSyncRequest(
    client: ConnectedClient,
    payload: { since?: string }
  ): Promise<void> {
    try {
      const result = await this.memoryManager.sync({ since: payload?.since });
      this.sendToClient(client.ws, {
        type: 'memory:sync',
        payload: result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error({ err: error }, 'Sync request failed');
    }
  }

  private sendToClient(ws: WebSocket, event: WSEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event), (err) => {
        if (err) logger.error({ err }, 'WebSocket send failed');
      });
    }
  }

  private broadcast(event: WSEvent): void {
    const message = JSON.stringify(event);
    this.clients.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message, (err) => {
          if (err) logger.error({ clientName: client.name, err }, 'WebSocket broadcast failed');
        });
      }
    });
  }

  private broadcastExcept(excludeId: string, event: WSEvent): void {
    const message = JSON.stringify(event);
    this.clients.forEach((client, id) => {
      if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message, (err) => {
          if (err) logger.error({ clientName: client.name, err }, 'WebSocket broadcast failed');
        });
      }
    });
  }

  private generateClientId(): string {
    return crypto.randomUUID();
  }

  getConnectedClientsInfo(projectId?: string): Array<{ id: string; name: string; agentName?: string; clientType: 'agent' | 'ui'; projectId?: string; connectedAt: string }> {
    let clients = Array.from(this.clients.values());
    if (projectId) {
      clients = clients.filter(c => c.projectId === projectId);
    }
    return clients.map(c => ({
      id: c.id,
      name: c.name,
      agentName: c.agentName,
      clientType: c.clientType,
      projectId: c.projectId,
      connectedAt: c.connectedAt.toISOString()
    }));
  }

  getConnectedCount(projectId?: string): number {
    if (!projectId) return this.clients.size;
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.projectId === projectId) count++;
    }
    return count;
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.wss) {
      this.clients.forEach((client) => client.ws.close());
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      logger.info('WebSocket server stopped');
    }
  }
}
