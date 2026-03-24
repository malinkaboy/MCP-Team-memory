/**
 * StreamableHTTP MCP transport mounted on Express
 */
import crypto from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Express, Request, Response } from 'express';
import logger from '../logger.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const transports = new Map<string, SessionEntry>();

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

// Periodic cleanup of abandoned sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of transports) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      try { session.transport.close?.(); } catch { /* ignore close errors */ }
      transports.delete(id);
      logger.info({ sessionId: id }, 'MCP session expired (TTL)');
    }
  }
  cleanupExpiredEntries();
}, CLEANUP_INTERVAL_MS).unref();

/** Check if a JSON-RPC body contains an initialize request */
export function isInitializeRequest(body: unknown): boolean {
  if (body == null) return false;
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (msg: any) => msg && typeof msg === 'object' && msg.method === 'initialize',
  );
}

export function mountMcpTransport(app: Express, createMcpServer: () => Server): void {
  // POST /mcp — JSON-RPC requests
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
      // Layer B check: if this session was recently 404'd, do transparent re-init
      if (recentlyExpired.has(sessionId) && Date.now() - recentlyExpired.get(sessionId)! < REINIT_WINDOW_MS) {
        // Layer B: transparent re-init — placeholder, returns 404 for now
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

  // GET /mcp — SSE stream for notifications
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const session = transports.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'No active session. Send a POST /mcp first.' });
    }
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const session = transports.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      transports.delete(sessionId);
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });
}
