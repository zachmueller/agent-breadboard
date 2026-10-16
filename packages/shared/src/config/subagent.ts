import { z } from 'zod';
import { zUid, zSlug, zEffort, SCHEMA_TAGS } from './common.js';

export const zToolGrant = z.object({
  tool: zUid,
  settings: z.record(z.string(), z.any()).optional(),
});
export const zMcpGrant = z.object({
  mcp: zUid,
  allow: z.array(z.string()).optional(),
});
export const zSubagentToolEntry = z.union([zToolGrant, zMcpGrant]);
export type ToolGrant = z.infer<typeof zToolGrant>;
export type McpGrant = z.infer<typeof zMcpGrant>;

export const zCircuitGrant = z.object({
  circuit: zUid,
  access: z.enum(['read', 'execute']),
});

export const zSubagent = z.object({
  schema: z.literal(SCHEMA_TAGS.subagent),
  uid: zUid,
  slug: zSlug,
  title: z.string().min(1),
  description: z.string().default(''),
  system_prompt: z.string().default(''),
  model_preset: z.string().min(1),
  /** Reasoning effort (low…max); unset = the model's default. A circuit LLM step's `effort` overrides it. */
  effort: zEffort.optional(),
  tools: z.array(zSubagentToolEntry).default([]),
  circuits: z.array(zCircuitGrant).default([]),
  knowledge: z
    .object({
      read: z.array(z.string()).default([]),
      write: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Built-in primitive allowlist (names from the Breadboard MCP catalog). Default: content + knowledge-read primitives. */
  primitives: z.array(z.string()).optional(),
});
export type Subagent = z.infer<typeof zSubagent>;

/** `{{knowledge:<UID>}}` dynamic injection tokens ([05] §2.1). */
export const KNOWLEDGE_TOKEN_RE = /\{\{\s*knowledge:([0-9A-HJKMNP-TV-Z]{20})\s*\}\}/g;
export function knowledgeTokens(prompt: string): string[] {
  return [...prompt.matchAll(KNOWLEDGE_TOKEN_RE)].map((m) => m[1]!);
}
