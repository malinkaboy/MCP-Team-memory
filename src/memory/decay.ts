import type { Priority } from './types.js';

export interface ScoreInput {
  readCount: number;
  relatedCount: number;
  priority: Priority;
  daysSinceLastRead: number;
  decayDays: number;
  weights: [number, number, number, number];
}

const PRIORITY_BONUS: Record<Priority, number> = {
  critical: 1.0,
  high: 0.5,
  medium: 0.2,
  low: 0.0,
};

/**
 * Calculate importance score for a memory entry.
 * Used for testing/debugging — the actual archival uses SQL (buildArchiveByScoreQuery).
 */
export function calculateImportanceScore(input: ScoreInput): number {
  const { readCount, relatedCount, priority, daysSinceLastRead, decayDays, weights } = input;
  const [w1, w2, w3, w4] = weights;

  const frequency = Math.min(readCount / 20, 1.0);
  const connections = Math.min(relatedCount / 5, 1.0);
  const priorityBonus = PRIORITY_BONUS[priority];
  const recency = Math.max(0, 1.0 - daysSinceLastRead / decayDays);

  return w1 * frequency + w2 * connections + w3 * priorityBonus + w4 * recency;
}

/**
 * Build SQL query that archives entries below the score threshold.
 * All score computation is done in SQL for efficiency.
 */
export function buildArchiveByScoreQuery(
  threshold: number,
  decayDays: number,
  weights: [number, number, number, number]
): { sql: string; params: unknown[] } {
  const [w1, w2, w3, w4] = weights;

  const sql = `
    UPDATE entries
    SET status = 'archived'
    WHERE status = 'active'
      AND pinned = false
      AND (
        $1 * LEAST(read_count::float / 20.0, 1.0)
        + $2 * LEAST(COALESCE(array_length(related_ids, 1), 0)::float / 5.0, 1.0)
        + $3 * CASE priority
            WHEN 'critical' THEN 1.0
            WHEN 'high' THEN 0.5
            WHEN 'medium' THEN 0.2
            WHEN 'low' THEN 0.0
            ELSE 0.0
          END
        + $4 * GREATEST(0, 1.0 - EXTRACT(EPOCH FROM NOW() - COALESCE(last_read_at, updated_at)) / ($5 * 86400.0))
      ) < $6
    RETURNING id
  `;

  return { sql, params: [w1, w2, w3, w4, decayDays, threshold] };
}
