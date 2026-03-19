-- Migration 007: Add 'conventions' category for project conventions
-- PostgreSQL auto-names inline CHECK constraints, so we find and drop dynamically.

DO $$
DECLARE cname TEXT;
BEGIN
  -- Find the category CHECK constraint on entries (name may vary across PG versions)
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'entries'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%category%';
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE entries DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;

ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions'));

-- entry_versions has no CHECK on category (just TEXT NOT NULL) — no action needed.
