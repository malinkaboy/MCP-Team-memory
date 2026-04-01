import { z } from 'zod';

const UuidSchema = z.string().uuid('Invalid UUID format');

export const SessionImportSchema = z.object({
  external_id: z.string().max(200).optional(),
  name: z.string().max(500).optional(),
  summary: z.string().min(1).max(10000),
  project_id: UuidSchema.optional(),
  working_directory: z.string().max(1000).optional(),
  git_branch: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().min(1).max(500000),
    timestamp: z.string().datetime().optional(),
    tool_names: z.array(z.string().max(100)).default([]),
  })).min(1).max(50000),
});

export const SessionListSchema = z.object({
  project_id: UuidSchema.optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).default(20).transform(v => Math.min(v, 100)),
  offset: z.number().int().min(0).default(0),
});

export const SessionSearchSchema = z.object({
  query: z.string().min(1).max(500),
  project_id: UuidSchema.optional(),
  limit: z.number().int().min(1).default(10).transform(v => Math.min(v, 50)),
});

export const SessionReadSchema = z.object({
  session_id: UuidSchema,
  message_from: z.number().int().min(0).default(0),
  message_to: z.number().int().min(0).optional(),
});

export const SessionMessageSearchSchema = z.object({
  query: z.string().min(1).max(500),
  session_id: UuidSchema.optional(),
  limit: z.number().int().min(1).default(10).transform(v => Math.min(v, 50)),
});

export const SessionDeleteSchema = z.object({
  session_id: UuidSchema,
});
