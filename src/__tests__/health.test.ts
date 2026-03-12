import { describe, it, expect, vi } from 'vitest';
import { createHealthHandler } from '../health.js';

function createMockPool(healthy: boolean) {
  return {
    query: healthy
      ? vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
      : vi.fn().mockRejectedValue(new Error('connection refused')),
  };
}

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.body = data; return res; },
  };
  return res;
}

describe('createHealthHandler', () => {
  it('returns healthy status when DB is up', async () => {
    const pool = createMockPool(true);
    const handler = createHealthHandler(pool as any);
    const res = createMockRes();

    await handler({} as any, res);

    expect(res.body.status).toBe('healthy');
    expect(res.body.checks.database.status).toBe('up');
    expect(res.body.checks.database.latencyMs).toBeTypeOf('number');
    expect(res.body.checks.memory.heapUsedMB).toBeTypeOf('number');
  });

  it('returns unhealthy status with 503 when DB is down', async () => {
    const pool = createMockPool(false);
    const handler = createHealthHandler(pool as any);
    const res = createMockRes();

    await handler({} as any, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.checks.database.status).toBe('down');
    expect(res.body.checks.database.error).toBe('connection refused');
  });
});
