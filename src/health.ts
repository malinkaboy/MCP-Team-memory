import type { Request, Response } from 'express';
import type pg from 'pg';
import logger from './logger.js';

export function createHealthHandler(pool: pg.Pool) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      const dbLatencyMs = Date.now() - start;

      const mem = process.memoryUsage();
      res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: 'up', latencyMs: dbLatencyMs },
          memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
          },
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Health check: database unreachable');
      const mem = process.memoryUsage();
      res.status(503).json({
        status: 'unhealthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: 'down', error: (err as Error).message },
          memory: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
          },
        },
      });
    }
  };
}
