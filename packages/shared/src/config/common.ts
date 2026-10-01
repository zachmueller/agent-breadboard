import { z } from 'zod';

export const UID_REGEX = /^[0-9A-HJKMNP-TV-Z]{20}$/;
export const zUid = z.string().regex(UID_REGEX, 'must be a 20-char Crockford base32 UID');
export const zSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with dashes');
export const zJsonSchema = z.record(z.string(), z.any());

export const zRetryPolicy = z.object({
  max_attempts: z.number().int().min(1).max(20).default(3),
  backoff: z
    .object({
      base_s: z.number().min(0).default(5),
      cap_s: z.number().min(0).default(300),
    })
    .prefault({}),
});
export type RetryPolicy = z.infer<typeof zRetryPolicy>;

export const DEFAULT_RETRY: RetryPolicy = { max_attempts: 3, backoff: { base_s: 5, cap_s: 300 } };
export const DEFAULT_MAX_VISITS = 25;

export const zBudget = z.object({
  max_cost_usd: z.number().positive(),
  max_tokens: z.number().int().positive(),
});
export type Budget = z.infer<typeof zBudget>;

/** Reviewer targeting using the need-input grammar ([09] §3). */
export const zReviewers = z.object({
  role: z.string().optional(),
  username: z.string().optional(),
  /** Optional list form for multiple targets; each becomes one request. */
  any_of: z.array(z.object({ role: z.string().optional(), username: z.string().optional() })).optional(),
});
export type Reviewers = z.infer<typeof zReviewers>;

export const CONFIG_KINDS = ['circuit', 'subagent', 'tool', 'mcp', 'presets', 'tenets', 'breadboard', 'rubric', 'fixtures'] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

export const SCHEMA_TAGS: Record<Exclude<ConfigKind, 'tenets'>, string> = {
  circuit: 'breadboard/circuit@v1',
  subagent: 'breadboard/subagent@v1',
  tool: 'breadboard/tool@v1',
  mcp: 'breadboard/mcp@v1',
  presets: 'breadboard/presets@v1',
  breadboard: 'breadboard/breadboard@v1',
  rubric: 'breadboard/rubric@v1',
  fixtures: 'breadboard/fixtures@v1',
};
