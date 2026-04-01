import { z } from 'zod';

const UuidSchema = z.string().uuid('Invalid UUID format');
const PriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
const StatusEnum = z.enum(['active', 'archived']);

export const NoteWriteSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().max(50)).max(20).default([]),
  priority: PriorityEnum.default('medium'),
  project_id: UuidSchema.optional(),
  session_id: UuidSchema.optional(),
});

export const NoteReadSchema = z.object({
  search: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  project_id: UuidSchema.optional(),
  session_id: UuidSchema.optional(),
  status: StatusEnum.optional(),
  mode: z.enum(['compact', 'full']).default('compact'),
  limit: z.number().int().min(1).default(50).transform(v => Math.min(v, 500)),
  offset: z.number().int().min(0).default(0),
});

export const NoteUpdateSchema = z.object({
  id: UuidSchema,
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  priority: PriorityEnum.optional(),
  status: StatusEnum.optional(),
  project_id: UuidSchema.nullable().optional(),
  session_id: UuidSchema.nullable().optional(),
});

export const NoteDeleteSchema = z.object({
  id: UuidSchema,
  archive: z.boolean().default(true),
});

export const NoteSearchSchema = z.object({
  query: z.string().min(1).max(500),
  project_id: UuidSchema.optional(),
  session_id: UuidSchema.optional(),
  limit: z.number().int().min(1).default(10).transform(v => Math.min(v, 50)),
});
