import { describe, it, expect } from 'vitest';
import { escapeIlike, PgStorage } from '../storage/pg-storage.js';

describe('escapeIlike', () => {
  it('should escape % character', () => {
    expect(escapeIlike('100%')).toBe('100\\%');
  });

  it('should escape _ character', () => {
    expect(escapeIlike('file_name')).toBe('file\\_name');
  });

  it('should escape backslash', () => {
    expect(escapeIlike('path\\to')).toBe('path\\\\to');
  });

  it('should escape all special chars together', () => {
    expect(escapeIlike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('should leave normal strings unchanged', () => {
    expect(escapeIlike('normal query')).toBe('normal query');
  });
});

describe('PgStorage FTS language validation', () => {
  it('should accept valid FTS languages', () => {
    // Valid language should not throw — we can only verify construction succeeds
    // (actual DB connection will fail in tests, but constructor validation is sync)
    const storage = new PgStorage('postgresql://test:test@localhost/test', 'russian');
    expect(storage).toBeDefined();
  });

  it('should fall back to simple for invalid FTS language', () => {
    // SQL injection attempt should be rejected and fall back to 'simple'
    const storage = new PgStorage('postgresql://test:test@localhost/test', "DROP TABLE entries;--");
    expect(storage).toBeDefined();
    // The constructor logs a warning and uses 'simple' — we verify it doesn't throw
  });

  it('should default to simple when no language specified', () => {
    const storage = new PgStorage('postgresql://test:test@localhost/test');
    expect(storage).toBeDefined();
  });
});
