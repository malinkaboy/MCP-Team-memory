import pino from 'pino';

/**
 * Create a pino logger.
 *
 * CRITICAL: In stdio mode, ANY stdout output corrupts MCP JSON-RPC protocol.
 * Stdio mode MUST always log to stderr (fd 2), regardless of NODE_ENV.
 * In HTTP mode: pretty-print to stderr in dev, JSON to stderr in production.
 */
export function createLogger(level?: string): pino.Logger {
  const logLevel = level || process.env.LOG_LEVEL || 'info';
  const isStdio = process.env.MEMORY_TRANSPORT === 'stdio';

  if (isStdio) {
    // Stdio mode: always stderr, JSON format (minimal overhead)
    return pino({ level: logLevel }, pino.destination(2));
  }

  // HTTP mode: pretty-print in dev, JSON to stderr in production
  if (process.env.NODE_ENV !== 'production') {
    return pino({
      level: logLevel,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
          destination: 2,
        },
      },
    });
  }

  return pino({ level: logLevel }, pino.destination(2));
}

/** Default logger instance -- import this in most files */
const logger = createLogger();
export default logger;
