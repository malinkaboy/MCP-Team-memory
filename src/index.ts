#!/usr/bin/env node
/**
 * Team Memory MCP Server v2
 *
 * Supports two transport modes:
 * - stdio: for local Claude Code integration (default)
 * - http:  for remote server with Web UI (set MEMORY_TRANSPORT=http)
 */

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (config.transport === 'http') {
  // HTTP mode — import and run app.ts
  await import('./app.js');
} else {
  // stdio mode — original MCP server behavior
  const { PgStorage } = await import('./storage/pg-storage.js');
  const { MemoryManager } = await import('./memory/manager.js');
  const { TeamMemoryMCPServer } = await import('./server.js');

  logger.info({ transport: 'stdio', database: config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@') }, 'Team Memory MCP Server v2 starting');

  try {
    const storage = new PgStorage(config.databaseUrl);
    const { AuditLogger } = await import('./storage/audit.js');
    const auditLogger = new AuditLogger(storage.getPool());
    const { VersionManager } = await import('./storage/versioning.js');
    const versionManager = new VersionManager(storage.getPool());
    const memoryManager = new MemoryManager(storage, auditLogger, versionManager);
    await memoryManager.initialize();

    const mcpServer = new TeamMemoryMCPServer(memoryManager);
    await mcpServer.start();

    if (config.autoArchiveEnabled) {
      memoryManager.startAutoArchive(config.autoArchiveDays);
      logger.info({ days: config.autoArchiveDays }, 'Auto-archive enabled');
    }

    logger.info('MCP Server ready. Waiting for commands...');

    process.on('SIGINT', async () => {
      await memoryManager.close();
      process.exit(0);
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}
