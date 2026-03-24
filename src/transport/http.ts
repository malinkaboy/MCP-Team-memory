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

const MCP_PROTOCOL_VERSION = '2025-03-26';

/**
 * Perform transparent session re-initialization.
 * Creates a new transport, runs synthetic init handshake via Web Standard API
 * (bypassing hono Node.js adapter), then forwards the original request.
 *
 * Uses private SDK field `_webStandardTransport` (tested with @modelcontextprotocol/sdk ^1.0.0).
 * If the SDK restructures internals, the runtime guard below will throw a clear error.
 */
async function performTransparentReinit(
  req: Request,
  res: Response,
  createMcpServer: () => Server,
): Promise<void> {
  const oldSessionId = req.headers['mcp-session-id'] as string;

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

  let mcpServer: Server | undefined;
  try {
    mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    // Access underlying Web Standard transport to bypass hono Node.js adapter.
    // Runtime guard: if SDK internals change, fail fast with a clear message.
    const webTransport = (transport as any)._webStandardTransport;
    if (!webTransport || typeof webTransport.handleRequest !== 'function') {
      throw new Error(
        'SDK internal structure changed: _webStandardTransport.handleRequest not found. ' +
        'Session recovery requires @modelcontextprotocol/sdk with WebStandardStreamableHTTPServerTransport.',
      );
    }

    // --- Step 1: Synthetic initialize handshake ---
    const initBody = {
      jsonrpc: '2.0',
      id: `synthetic-init-${crypto.randomUUID()}`,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'recovered-client', version: '1.0.0' },
      },
    };

    const initReq = new globalThis.Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initBody),
    });

    const initRes = await webTransport.handleRequest(initReq, { parsedBody: initBody });
    if (initRes.status !== 200) {
      const errorText = await initRes.text();
      throw new Error(`Synthetic init failed with status ${initRes.status}: ${errorText}`);
    }

    const newSessionId = transport.sessionId;
    if (!newSessionId) {
      throw new Error('Transport did not generate session ID after synthetic init');
    }

    // --- Step 2: Synthetic notifications/initialized ---
    const notifBody = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const notifReq = new globalThis.Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': newSessionId,
      },
      body: JSON.stringify(notifBody),
    });

    await webTransport.handleRequest(notifReq, { parsedBody: notifBody });

    // --- Step 3: Forward original request via Web Standard API ---
    // We must use webTransport directly because hono's Node.js adapter
    // reads raw headers from IncomingMessage which we cannot reliably override.
    // Note: webRes.text() buffers the response — safe for JSON-RPC but would
    // not work for SSE streams. Tool calls always return JSON.
    const forwardHeaders: Record<string, string> = {
      'content-type': req.headers['content-type'] as string || 'application/json',
      accept: req.headers['accept'] as string || 'application/json, text/event-stream',
      'mcp-session-id': newSessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    };

    const forwardReq = new globalThis.Request('http://localhost/mcp', {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(req.body),
    });

    const webRes: globalThis.Response = await webTransport.handleRequest(forwardReq, {
      parsedBody: req.body,
      authInfo: (req as any).auth,
    });

    // Write Web Standard Response back to Express ServerResponse
    res.status(webRes.status);
    webRes.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });
    const body = await webRes.text();
    res.end(body);
  } catch (err) {
    // Clean up orphaned transport/server on failure
    if (mcpServer) await mcpServer.close().catch(() => {});
    throw err;
  }
}

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
      // Layer B: if this session was recently 404'd, do transparent re-init
      if (recentlyExpired.has(sessionId) && Date.now() - recentlyExpired.get(sessionId)! < REINIT_WINDOW_MS) {
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
          logger.info({ sessionId, method: (req.body as any)?.method, toolName: (req.body as any)?.params?.name }, 'MCP transparent re-init started');
          await performTransparentReinit(req, res, createMcpServer);
          recentlyExpired.delete(sessionId);
        } catch (err) {
          logger.error({ sessionId, err }, 'MCP transparent re-init failed');
          recentlyExpired.delete(sessionId);
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
