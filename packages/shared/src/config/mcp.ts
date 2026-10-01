import { z } from 'zod';
import { zUid, zSlug, SCHEMA_TAGS } from './common.js';

export const zMcpServer = z.object({
  schema: z.literal(SCHEMA_TAGS.mcp),
  uid: zUid,
  slug: zSlug,
  title: z.string().min(1),
  description: z.string().default(''),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).prefault({}),
  endpoint: z.string().url().optional(),
  /** Broker capability whose credential is attached (as a bearer header or env var) when connecting. */
  auth: z
    .object({
      capability: z.string(),
      /** How to apply: `header` (Authorization: Bearer) or `env:<NAME>` for stdio servers. */
      apply: z.string().default('header'),
    })
    .optional(),
  tools: z.object({ allow: z.array(z.string()).optional() }).prefault({}),
});
export type McpServer = z.infer<typeof zMcpServer>;
