import { z } from 'zod';
import { zUid, zSlug, zJsonSchema, zRetryPolicy, zBudget, zReviewers, zEffort, SCHEMA_TAGS } from './common.js';

export const zStepExit = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'exit names are lowercase-dash'),
  /** Step id, or `$exit.<name>` for a declared circuit exit. */
  to: z.string().min(1),
  description: z.string().optional(),
});
export type StepExit = z.infer<typeof zStepExit>;

const stepBase = {
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'step ids are lowercase-dash'),
  title: z.string().optional(),
  description: z.string().optional(),
  exits: z.array(zStepExit).min(1),
  retry: zRetryPolicy.optional(),
  max_visits: z.number().int().min(1).optional(),
  /** Tag applied to artifacts the step produces: defaults to `intermediate` for session-scoped outputs ([09] §2.1). */
  artifacts: z
    .object({
      tag: z.enum(['intermediate', 'deliverable']).optional(),
      scope: z.enum(['team', 'session']).optional(),
    })
    .optional(),
};

export const zLlmStep = z.object({
  ...stepBase,
  kind: z.literal('llm'),
  subagent: zUid,
  /** Path (relative to the circuit dir) of the prompt template, or inline template text under `prompt_inline`. */
  prompt: z.string().optional(),
  prompt_inline: z.string().optional(),
  /** Narrowing only: list of tool UIDs the step may use (subset of the subagent's grants). `[]` = no tools. Omit for no override. */
  tools_override: z.array(zUid).optional(),
  output: zJsonSchema,
  /** Max schema-invalid finish re-asks within one attempt. */
  max_reasks: z.number().int().min(0).max(10).default(2),
  max_turns: z.number().int().min(1).max(500).default(60),
  /** Reasoning effort for this step; overrides the subagent's. Ignored by models that do not reason. */
  effort: zEffort.optional(),
});

export const zCodeStep = z.object({
  ...stepBase,
  kind: z.literal('code'),
  tool: zUid,
  /** Explicit wiring: key → `$input.x` | `$steps.<id>.output.x` | `$ambient.x` | literal. */
  input_map: z.record(z.string(), z.any()).optional(),
  output: zJsonSchema.optional(),
  /** Per-grant settings for the tool when invoked by this step. */
  settings: z.record(z.string(), z.any()).optional(),
});

export const zCircuitStep = z.object({
  ...stepBase,
  kind: z.literal('circuit'),
  circuit: zUid,
  input_map: z.record(z.string(), z.any()).optional(),
  /** Optional 1:1 renaming of the child's exits: child exit → this step's exit name. Default identity. */
  exit_map: z.record(z.string(), z.string()).optional(),
});

export const zGateStep = z.object({
  ...stepBase,
  kind: z.literal('gate'),
  review: z.object({
    /** `$steps.<id>.output.<path>` expressions resolving to artifact refs (or arrays of them). */
    artifacts: z.array(z.string()).min(1),
    reviewers: zReviewers,
    prompt: z.string().optional(),
  }),
  output: zJsonSchema,
});

export const zStep = z.discriminatedUnion('kind', [zLlmStep, zCodeStep, zCircuitStep, zGateStep]);
export type Step = z.infer<typeof zStep>;
export type LlmStep = z.infer<typeof zLlmStep>;
export type CodeStep = z.infer<typeof zCodeStep>;
export type CircuitStep = z.infer<typeof zCircuitStep>;
export type GateStep = z.infer<typeof zGateStep>;

export const zCircuitExit = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().optional(),
  output: zJsonSchema.optional(),
});

export const zCircuit = z.object({
  schema: z.literal(SCHEMA_TAGS.circuit),
  uid: zUid,
  slug: zSlug,
  title: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  budget: zBudget.optional(),
  input: zJsonSchema.default({ type: 'object' }),
  exits: z.array(zCircuitExit).min(1),
  entry: z.string().min(1),
  steps: z.array(zStep).min(1),
  /** Optional circuit-level knowledge grants (read domains) applied to every LLM step ([07] §3). */
  knowledge: z.object({ read: z.array(z.string()).default([]) }).optional(),
  /** Per-run ceiling on summed tool `max_cost_units` ([06] §4). */
  max_tool_cost_units: z.number().positive().optional(),
});
export type Circuit = z.infer<typeof zCircuit>;

export const EXIT_PREFIX = '$exit.';
export const isCircuitExitTarget = (to: string) => to.startsWith(EXIT_PREFIX);
export const circuitExitName = (to: string) => to.slice(EXIT_PREFIX.length);
