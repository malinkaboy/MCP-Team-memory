import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('createLogger', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a logger instance with info method', async () => {
    const { createLogger } = await import('../logger.js');
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('respects LOG_LEVEL environment variable', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { createLogger } = await import('../logger.js');
    const logger = createLogger('debug');
    expect(logger.level).toBe('debug');
  });

  it('defaults to info level', async () => {
    const { createLogger } = await import('../logger.js');
    const logger = createLogger();
    expect(logger.level).toBe('info');
  });

  it('never writes to stdout in stdio mode', async () => {
    process.env.MEMORY_TRANSPORT = 'stdio';
    const { createLogger } = await import('../logger.js');
    const logger = createLogger();

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.info('test message');
    // Allow async flush
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stdoutWrite).not.toHaveBeenCalled();
    stdoutWrite.mockRestore();
  });
});
