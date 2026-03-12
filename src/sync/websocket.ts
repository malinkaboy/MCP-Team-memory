import { WebSocketServer, WebSocket } from 'ws';
import type http from 'http';
import crypto from 'crypto';
import type { MemoryManager } from '../memory/manager.js';
import type { WSEvent } from '../memory/types.js';
import logger from '../logger.js';

interface ConnectedClient {
  ws: WebSocket;
  id: string;
  name: string;
  connectedAt: Date;
}

export class SyncWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private memoryManager: MemoryManager;
  private apiToken: string | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(memoryManager: MemoryManager, apiToken?: string) {
    this.memoryManager = memoryManager;
    this.apiToken = apiToken;
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
      // Verify token if auth is enabled
      const effectiveToken = this.apiToken?.trim();
      if (effectiveToken) {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const token = url.searchParams.get('token') || req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) {
          ws.close(4401, 'Unauthorized');
          return;
        }
        const tokenBuf = Buffer.from(token);
        const expectedBuf = Buffer.from(effectiveToken);
        if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
          ws.close(4401, 'Unauthorized');
          return;
        }
      }

      const clientId = this.generateClientId();
      const clientName = req.headers['x-agent-name']?.toString() || `agent-${clientId.slice(0, 8)}`;

      const client: ConnectedClient = {
        ws,
        id: clientId,
        name: clientName,
        connectedAt: new Date()
      };

      this.clients.set(clientId, client);
      logger.info({ clientName, clientId }, 'Client connected');

      this.sendToClient(ws, {
        type: 'agent:connected',
        payload: {
          clientId,
          clientName,
          connectedClients: this.getConnectedClientsInfo()
        },
        timestamp: new Date().toISOString()
      });

      this.broadcastExcept(clientId, {
        type: 'agent:connected',
        payload: { clientId, clientName },
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
        logger.info({ clientName, clientId }, 'Client disconnected');
        this.broadcast({
          type: 'agent:disconnected',
          payload: { clientId, clientName },
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
        const newName = (msg.payload as { name?: string })?.name;
        if (newName) {
          client.name = newName;
          this.broadcast({
            type: 'agent:connected',
            payload: { clientId, clientName: newName, renamed: true },
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

  getConnectedClientsInfo(): Array<{ id: string; name: string; connectedAt: string }> {
    return Array.from(this.clients.values()).map(c => ({
      id: c.id,
      name: c.name,
      connectedAt: c.connectedAt.toISOString()
    }));
  }

  getConnectedCount(): number {
    return this.clients.size;
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
