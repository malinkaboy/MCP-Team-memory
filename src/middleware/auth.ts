import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../logger.js';

/**
 * Creates Bearer token auth middleware.
 * If token is undefined — auth is disabled (all requests pass through).
 * Static files and health checks are excluded from auth.
 */
export function createAuthMiddleware(token: string | undefined) {
  const trimmedToken = token?.trim() || undefined;
  if (token !== undefined && !trimmedToken) {
    logger.warn('MEMORY_API_TOKEN is empty/whitespace — auth is disabled');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // No token configured — auth disabled
    if (!trimmedToken) {
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

    // Timing-safe comparison to prevent timing attacks
    const tokenBuffer = Buffer.from(trimmedToken);
    const providedBuffer = Buffer.from(provided);

    if (tokenBuffer.length !== providedBuffer.length ||
        !crypto.timingSafeEqual(tokenBuffer, providedBuffer)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}
