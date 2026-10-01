import { z } from 'zod';
import { zUid, zSlug, zJsonSchema, SCHEMA_TAGS } from './common.js';

export const zToolSetting = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  default: z.any().optional(),
  description: z.string().optional(),
  hidden: z.boolean().default(false),
  enum: z.array(z.any()).optional(),
});

export const zTool = z.object({
  schema: z.literal(SCHEMA_TAGS.tool),
  uid: zUid,
  slug: zSlug,
  title: z.string().min(1),
  description: z.string().default(''),
  language: z.enum(['typescript', 'python']),
  entrypoint: z.string().min(1),
  input: zJsonSchema.default({ type: 'object' }),
  output: zJsonSchema.optional(),
  settings: z.record(z.string(), zToolSetting).prefault({}),
  limits: z
    .object({
      timeout_s: z.number().positive().max(3600).default(120),
      memory_mb: z.number().int().positive().max(16384).default(512),
      cpus: z.number().positive().max(16).default(1),
      pids: z.number().int().positive().default(256),
      max_cost_units: z.number().nonnegative().default(1),
    })
    .prefault({}),
  egress: z
    .object({
      allow: z
        .array(
          z.object({
            host: z.string().min(1),
            ports: z.array(z.number().int().positive()).default([443]),
          }),
        )
        .default([]),
    })
    .prefault({}),
  capabilities: z.array(z.object({ name: z.string().min(1), scope: z.string().default('read') })).default([]),
  exposure: z.object({ external_mcp: z.boolean().default(false) }).prefault({}),
  /** Connector tools implement `list`/`fetch` and are scheduled ([07] §8). */
  connector: z
    .object({
      schedule_minutes: z.number().positive().default(360),
      domains: z.array(z.string()).default([]),
    })
    .optional(),
  /** Marks a tool as shipped-with-Breadboard (forkable). */
  builtin: z.boolean().default(false),
});
export type Tool = z.infer<typeof zTool>;
