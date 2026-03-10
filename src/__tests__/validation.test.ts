import { describe, it, expect } from 'vitest';
import {
  ReadParamsSchema,
  WriteParamsSchema,
  UpdateParamsSchema,
  DeleteParamsSchema,
} from '../memory/validation.js';

describe('ReadParamsSchema', () => {
  it('accepts valid params', () => {
    const result = ReadParamsSchema.safeParse({
      category: 'tasks',
      limit: 10,
      status: 'active',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid category', () => {
    const result = ReadParamsSchema.safeParse({ category: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects negative limit', () => {
    const result = ReadParamsSchema.safeParse({ limit: -5 });
    expect(result.success).toBe(false);
  });

  it('clamps limit to max 500', () => {
    const result = ReadParamsSchema.safeParse({ limit: 99999 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(500);
    }
  });

  it('defaults category to all', () => {
    const result = ReadParamsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.category).toBe('all');
    }
  });
});

describe('WriteParamsSchema', () => {
  it('requires category, title, content', () => {
    const result = WriteParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid write params', () => {
    const result = WriteParamsSchema.safeParse({
      category: 'tasks',
      title: 'Test',
      content: 'Body',
    });
    expect(result.success).toBe(true);
  });

  it('rejects title longer than 500 chars', () => {
    const result = WriteParamsSchema.safeParse({
      category: 'tasks',
      title: 'A'.repeat(501),
      content: 'Body',
    });
    expect(result.success).toBe(false);
  });

  it('rejects content longer than 50000 chars', () => {
    const result = WriteParamsSchema.safeParse({
      category: 'tasks',
      title: 'Test',
      content: 'X'.repeat(50001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid priority', () => {
    const result = WriteParamsSchema.safeParse({
      category: 'tasks',
      title: 'Test',
      content: 'Body',
      priority: 'SUPER_HIGH',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateParamsSchema', () => {
  it('requires id', () => {
    const result = UpdateParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts id with optional fields', () => {
    const result = UpdateParamsSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Updated',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID for id', () => {
    const result = UpdateParamsSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });
});

describe('DeleteParamsSchema', () => {
  it('requires id', () => {
    const result = DeleteParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('defaults archive to true', () => {
    const result = DeleteParamsSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.archive).toBe(true);
    }
  });
});
