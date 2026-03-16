import type { MemoryManager } from './memory/manager.js';
import type { MemoryEntry } from './memory/types.js';
import { DEFAULT_PROJECT_ID } from './memory/types.js';
import logger from './logger.js';

export interface AutoContextOptions {
  projectId?: string;
  context?: string;  // Current task description for semantic matching
  limit?: number;
}

export interface AutoContextResult {
  entries: MemoryEntry[];
  formatted: string;
}

/**
 * Build automatic context by combining:
 * 1. Pinned entries (explicitly important)
 * 2. Recently updated entries
 * 3. Semantic matches (if context + embeddings available)
 * Deduplicates across all sources.
 */
export async function buildAutoContext(
  manager: MemoryManager,
  opts: AutoContextOptions
): Promise<AutoContextResult> {
  const { projectId, context, limit = 10 } = opts;
  const storage = manager.getStorage();
  const seen = new Set<string>();
  const allEntries: MemoryEntry[] = [];

  const addUnique = (entries: MemoryEntry[]) => {
    for (const entry of entries) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        allEntries.push(entry);
      }
    }
  };

  // 1. Pinned entries — always included
  try {
    const pinned = await storage.getAll(
      projectId || DEFAULT_PROJECT_ID,
      { status: 'active', limit: 20 }
    );
    addUnique(pinned.filter(e => e.pinned));
  } catch (err) {
    logger.error({ err }, 'Auto-recall: failed to fetch pinned entries');
  }

  // 2. Recently updated entries
  try {
    const recent = await storage.getAll(
      projectId || DEFAULT_PROJECT_ID,
      { status: 'active', limit: 5 }
    );
    addUnique(recent);
  } catch (err) {
    logger.error({ err }, 'Auto-recall: failed to fetch recent entries');
  }

  // 3. Semantic matches (if context provided + embeddings enabled)
  if (context) {
    const embeddingProvider = manager.getEmbeddingProvider();
    if (embeddingProvider?.isReady()) {
      try {
        const queryEmbedding = await embeddingProvider.embed(context);
        const semantic = await storage.hybridSearch(
          projectId || DEFAULT_PROJECT_ID,
          context,
          queryEmbedding,
          { limit: 5 }
        );
        addUnique(semantic);
      } catch (err) {
        logger.error({ err }, 'Auto-recall: semantic search failed');
      }
    }
  }

  // Trim to limit
  const entries = allEntries.slice(0, limit);

  // Format output
  const formatted = formatAutoContext(entries);

  return { entries, formatted };
}

function formatAutoContext(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return 'No relevant team memory entries found.';
  }

  const lines: string[] = ['# Team Memory Context', ''];

  for (const entry of entries) {
    const pin = entry.pinned ? ' [pinned]' : '';
    const priority = entry.priority !== 'medium' ? ` (${entry.priority})` : '';
    lines.push(`## ${entry.title}${pin}${priority}`);
    lines.push(`**Category:** ${entry.category} | **Domain:** ${entry.domain || 'general'} | **Updated:** ${entry.updatedAt}`);
    if (entry.tags.length > 0) {
      lines.push(`**Tags:** ${entry.tags.join(', ')}`);
    }
    // Truncate long content
    const content = entry.content.length > 300
      ? entry.content.substring(0, 300) + '...'
      : entry.content;
    lines.push('', content, '', '---', '');
  }

  return lines.join('\n');
}
