#!/usr/bin/env node
/**
 * Team Memory MCP Server v2
 *
 * Supports two transport modes:
 * - stdio: for local Claude Code integration (default)
 * - http:  for remote server with Web UI (set MEMORY_TRANSPORT=http)
 */

import { loadConfig } from './config.js';

const config = loadConfig();

if (config.transport === 'http') {
  // HTTP mode — import and run app.ts
  await import('./app.js');
} else {
  // stdio mode — original MCP server behavior
  const { PgStorage } = await import('./storage/pg-storage.js');
  const { MemoryManager } = await import('./memory/manager.js');
  const { TeamMemoryMCPServer } = await import('./server.js');

  console.error('='.repeat(50));
  console.error('Team Memory MCP Server v2 (stdio mode)');
  console.error('='.repeat(50));
  console.error(`Database: ${config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@')}`);
  console.error('='.repeat(50));

  try {
    const storage = new PgStorage(config.databaseUrl);
    const { AuditLogger } = await import('./storage/audit.js');
    const auditLogger = new AuditLogger(storage.getPool());
    const memoryManager = new MemoryManager(storage, auditLogger);
    await memoryManager.initialize();

    const mcpServer = new TeamMemoryMCPServer(memoryManager);
    await mcpServer.start();

    if (config.autoArchiveEnabled) {
      memoryManager.startAutoArchive(config.autoArchiveDays);
      console.error(`Auto-archive: entries older than ${config.autoArchiveDays} days`);
    }

    console.error('MCP Server ready. Waiting for commands...');

    process.on('SIGINT', async () => {
      await memoryManager.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}
