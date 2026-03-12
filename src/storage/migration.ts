/**
 * Migration tool: v1 JSON → v2 PostgreSQL
 */
import { readFileSync, existsSync, renameSync } from 'fs';
import { PgStorage } from './pg-storage.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';
import type { MemoryStore, MemoryEntry, LegacyMemoryEntry } from '../memory/types.js';
import crypto from 'crypto';
import logger from '../logger.js';

export interface MigrationResult {
  migrated: number;
  errors: number;
  total: number;
}

export async function migrateFromJson(
  jsonPath: string,
  storage: PgStorage
): Promise<MigrationResult> {
  if (!existsSync(jsonPath)) {
    logger.info({ jsonPath }, 'Migration: JSON file not found');
    return { migrated: 0, errors: 0, total: 0 };
  }

  // Skip migration if PostgreSQL already has data (prevents duplicate imports)
  const existingCount = await storage.count();
  if (existingCount > 0) {
    logger.info({ existingCount }, 'Migration: Skipped — PostgreSQL already has entries');
    return { migrated: 0, errors: 0, total: 0 };
  }

  const raw = readFileSync(jsonPath, 'utf-8');
  const store: MemoryStore = JSON.parse(raw);

  let migrated = 0;
  let errors = 0;
  const total = store.entries.length;

  logger.info({ total, jsonPath }, 'Migration: Found entries in JSON file');

  for (const legacy of store.entries) {
    try {
      const entry: MemoryEntry = {
        id: legacy.id || crypto.randomUUID(),
        projectId: DEFAULT_PROJECT_ID,
        category: legacy.category,
        domain: null,
        title: legacy.title,
        content: legacy.content,
        author: legacy.author || 'unknown',
        tags: legacy.tags || [],
        priority: legacy.priority || 'medium',
        status: legacy.status || 'active',
        pinned: legacy.pinned || false,
        createdAt: legacy.createdAt || new Date().toISOString(),
        updatedAt: legacy.updatedAt || new Date().toISOString(),
        relatedIds: legacy.relatedIds || [],
      };

      await storage.add(entry);
      migrated++;
    } catch (err) {
      errors++;
      logger.error({ title: legacy.title, err }, 'Migration: Failed to migrate entry');
    }
  }

  logger.info({ migrated, errors, total }, 'Migration complete');

  // Rename the JSON file to prevent re-migration
  try {
    renameSync(jsonPath, `${jsonPath}.migrated`);
    logger.info({ jsonPath }, 'Migration: Renamed to .migrated');
  } catch {
    logger.warn({ jsonPath }, 'Migration: Could not rename file');
  }

  return { migrated, errors, total };
}
