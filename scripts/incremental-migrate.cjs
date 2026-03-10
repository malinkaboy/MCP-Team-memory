/**
 * Incremental migration: adds entries from memory.json that don't exist in PostgreSQL
 */
const { readFileSync } = require('fs');
const pg = require('pg');

const DB_URL = process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory';
const JSON_PATH = process.argv[2] || './data/memory.json';
const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  // Get existing IDs
  const res = await client.query('SELECT id FROM entries');
  const dbIds = new Set(res.rows.map(r => r.id));

  // Load JSON
  const store = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
  const missing = store.entries.filter(e => !dbIds.has(e.id));

  console.log(`DB: ${dbIds.size} entries | JSON: ${store.entries.length} entries | To migrate: ${missing.length}`);

  if (missing.length === 0) {
    console.log('Nothing to migrate.');
    await client.end();
    return;
  }

  let migrated = 0;
  let errors = 0;

  for (const entry of missing) {
    try {
      await client.query(
        `INSERT INTO entries (id, project_id, category, domain, title, content, author, tags, priority, status, pinned, created_at, updated_at, related_ids, search_vector)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 to_tsvector('russian', coalesce($5,'') || ' ' || coalesce($6,'') || ' ' || array_to_string($8::text[], ' ')))
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          DEFAULT_PROJECT_ID,
          entry.category,
          entry.domain || null,
          entry.title,
          entry.content,
          entry.author || 'unknown',
          entry.tags || [],
          entry.priority || 'medium',
          entry.status || 'active',
          entry.pinned || false,
          entry.createdAt || new Date().toISOString(),
          entry.updatedAt || new Date().toISOString(),
          entry.relatedIds || [],
        ]
      );
      migrated++;
      console.log(`  + ${entry.title}`);
    } catch (err) {
      errors++;
      console.error(`  ! Failed: ${entry.title} — ${err.message}`);
    }
  }

  console.log(`\nDone: ${migrated} migrated, ${errors} errors`);

  // Verify
  const countRes = await client.query('SELECT count(*) FROM entries');
  console.log(`Total entries in DB now: ${countRes.rows[0].count}`);

  await client.end();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
