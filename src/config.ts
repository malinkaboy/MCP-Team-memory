/**
 * Centralized configuration from environment variables
 */

export interface AppConfig {
  databaseUrl: string;
  transport: 'http' | 'stdio';
  port: number;
  autoArchiveEnabled: boolean;
  autoArchiveDays: number;
  apiToken: string | undefined;
  logLevel: string;
}

/** Parse integer with fallback to default on NaN */
export function parseIntSafe(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory',
    transport: (process.env.MEMORY_TRANSPORT as 'http' | 'stdio') || 'http',
    port: parseIntSafe(process.env.MEMORY_PORT || '3846', 3846),
    autoArchiveEnabled: process.env.MEMORY_AUTO_ARCHIVE !== 'false',
    autoArchiveDays: parseIntSafe(process.env.MEMORY_AUTO_ARCHIVE_DAYS || '14', 14),
    apiToken: process.env.MEMORY_API_TOKEN || undefined,
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
