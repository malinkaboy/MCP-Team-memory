import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../logger.js';
import type { AgentTokenStore } from '../auth/agent-tokens.js';

/**
 * Creates Bearer token auth middleware.
 * If token is undefined — auth is disabled (all requests pass through).
 * Static files and health checks are excluded from auth.
 *
 * With agentTokenStore: resolves per-agent tokens first, then falls back to master token.
 * Sets req.agentName and req.agentRole for downstream handlers.
 * Sets (req as any).auth for MCP SDK StreamableHTTPServerTransport compatibility.
 */
export function createAuthMiddleware(
  token: string | undefined,
  agentTokenStore?: AgentTokenStore
) {
  const trimmedToken = token?.trim() || undefined;
  if (token !== undefined && !trimmedToken) {
    logger.warn('MEMORY_API_TOKEN is empty/whitespace — auth is disabled');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // No token configured — auth disabled, but still extract X-Project-Id
    if (!trimmedToken) {
      const projectId = req.headers['x-project-id'] as string | undefined;
      if (projectId) {
        (req as any).auth = { clientId: 'master', scopes: [], projectId };
      }
      next();
      return;
    }

    // Skip auth for static files, root page, and health
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/mcp')) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Authorization header required' });
      return;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }

    const provided = match[1];

    // 1. Try agent token store (per-agent identity)
    if (agentTokenStore) {
      const agentInfo = agentTokenStore.resolve(provided);
      if (agentInfo) {
        req.agentName = agentInfo.agentName;
        req.agentRole = agentInfo.role;
        // MCP SDK reads req.auth for StreamableHTTPServerTransport → extra.authInfo
        const projectId = req.headers['x-project-id'] as string | undefined;
        (req as any).auth = { clientId: agentInfo.agentName, scopes: [agentInfo.role], projectId };
        agentTokenStore.trackLastUsed(agentInfo.id);
        next();
        return;
      }
    }

    // 2. Fallback: master token (MEMORY_API_TOKEN) — timing-safe comparison
    const tokenBuffer = Buffer.from(trimmedToken);
    const providedBuffer = Buffer.from(provided);

    if (tokenBuffer.length !== providedBuffer.length ||
        !crypto.timingSafeEqual(tokenBuffer, providedBuffer)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    // Master token — full admin access, no agentName (author comes from params)
    const projectId = req.headers['x-project-id'] as string | undefined;
    (req as any).auth = { clientId: 'master', scopes: ['admin'], projectId };
    next();
  };
}
