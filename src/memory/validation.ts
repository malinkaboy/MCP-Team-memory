import { z } from 'zod';

const CategoryEnum = z.enum([
  'architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions',
]);

const CategoryWithAllEnum = z.enum([
  'architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all',
]);

const PriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
const StatusEnum = z.enum(['active', 'completed', 'archived']);
const UuidSchema = z.string().uuid('Invalid UUID format');

export const ReadParamsSchema = z.object({
  project_id: z.string().optional(),
  category: CategoryWithAllEnum.default('all'),
  domain: z.string().max(100).optional(),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).default(50).transform(v => Math.min(v, 500)),
  offset: z.number().int().min(0).default(0).transform(v => Math.min(v, 10000)),
  status: StatusEnum.optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  ids: z.array(UuidSchema).max(100).optional(),
  mode: z.enum(['compact', 'full']).default('compact'),
});

export const WriteParamsSchema = z.object({
  project_id: z.string().optional(),
  category: CategoryEnum,
  domain: z.string().max(100).optional(),
  title: z.string().min(1, 'Title is required').max(500, 'Title too long (max 500)'),
  content: z.string().min(1, 'Content is required').max(50000, 'Content too long (max 50000)'),
  tags: z.array(z.string().max(50)).max(20).default([]),
  priority: PriorityEnum.default('medium'),
  author: z.string().max(100).default('claude-agent'),
  pinned: z.boolean().default(false),
  relatedIds: z.array(UuidSchema).max(50).optional(),
});

export const UpdateParamsSchema = z.object({
  id: UuidSchema,
  expected_version: z.number().int().min(0).optional(),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  domain: z.string().max(100).nullable().optional(),
  status: StatusEnum.optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  priority: PriorityEnum.optional(),
  pinned: z.boolean().optional(),
  relatedIds: z.array(UuidSchema).max(50).optional(),
});

export const DeleteParamsSchema = z.object({
  id: UuidSchema,
  archive: z.boolean().default(true),
});

export const SyncParamsSchema = z.object({
  project_id: z.string().optional(),
  since: z.string().datetime().optional(),
});

export const PinParamsSchema = z.object({
  id: UuidSchema,
  pinned: z.boolean().default(true),
});

export const ProjectActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({
    action: z.literal('create'),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    domains: z.array(z.string().max(50)).max(20).optional(),
  }),
  z.object({
    action: z.literal('update'),
    id: UuidSchema,
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    domains: z.array(z.string().max(50)).max(20).optional(),
  }),
  z.object({
    action: z.literal('delete'),
    id: UuidSchema,
  }),
]);

export const AuditParamsSchema = z.object({
  entry_id: UuidSchema.optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).default(20).transform(v => Math.min(v, 200)),
});

export const HistoryParamsSchema = z.object({
  entry_id: UuidSchema,
  version: z.number().int().min(1).optional(),
});

export const ExportParamsSchema = z.object({
  project_id: z.string().optional(),
  format: z.enum(['markdown', 'json']).default('markdown'),
  category: CategoryWithAllEnum.default('all'),
});

export const CrossSearchParamsSchema = z.object({
  query: z.string().min(1).max(500),
  category: CategoryWithAllEnum.optional(),
  domain: z.string().max(100).optional(),
  exclude_project_id: z.string().optional(),
  limit: z.number().int().min(1).default(20).transform(v => Math.min(v, 100)),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}
