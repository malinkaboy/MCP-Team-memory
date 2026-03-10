import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory fixed-window rate limiter.
 * No external dependencies needed for single-instance deployment.
 */
export function createRateLimiter(options: {
  windowMs?: number;   // Time window in ms (default: 60s)
  maxRequests?: number; // Max requests per window (default: 100)
} = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 100;
  const store = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every windowMs
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate limiting for static files
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/mcp')) {
      next();
      return;
    }

    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Too many requests',
        retryAfter,
      });
      return;
    }

    next();
  };
}
