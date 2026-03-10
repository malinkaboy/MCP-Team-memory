/**
 * Migration tool: v1 JSON → v2 PostgreSQL
 */
import { readFileSync, existsSync, renameSync } from 'fs';
import { PgStorage } from './pg-storage.js';
import type { MemoryStore, MemoryEntry, LegacyMemoryEntry } from '../memory/types.js';
import crypto from 'crypto';

const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

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
    console.error(`Migration: JSON file not found at ${jsonPath}`);
    return { migrated: 0, errors: 0, total: 0 };
  }

  // Skip migration if PostgreSQL already has data (prevents duplicate imports)
  const existingCount = await storage.count();
  if (existingCount > 0) {
    console.error(`Migration: Skipped — PostgreSQL already has ${existingCount} entries`);
    return { migrated: 0, errors: 0, total: 0 };
  }

  const raw = readFileSync(jsonPath, 'utf-8');
  const store: MemoryStore = JSON.parse(raw);

  let migrated = 0;
  let errors = 0;
  const total = store.entries.length;

  console.error(`Migration: Found ${total} entries in ${jsonPath}`);

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
      console.error(`Migration: Failed to migrate entry "${legacy.title}":`, err);
    }
  }

  console.error(`Migration complete: ${migrated} migrated, ${errors} errors out of ${total} total`);

  // Rename the JSON file to prevent re-migration
  try {
    renameSync(jsonPath, `${jsonPath}.migrated`);
    console.error(`Migration: Renamed ${jsonPath} → ${jsonPath}.migrated`);
  } catch {
    console.error(`Migration: Could not rename ${jsonPath}`);
  }

  return { migrated, errors, total };
}
