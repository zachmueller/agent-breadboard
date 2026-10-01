import { z } from 'zod';
import { zUid, SCHEMA_TAGS } from './common.js';

const dimBase = {
  key: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().optional(),
};

export const zNumericDim = z.object({ ...dimBase, type: z.literal('numeric'), scale: z.object({ min: z.number(), max: z.number() }), prompt: z.string().min(1) });
export const zOrdinalDim = z.object({ ...dimBase, type: z.literal('ordinal'), levels: z.array(z.string()).min(2), prompt: z.string().min(1) });
export const zBooleanDim = z.object({ ...dimBase, type: z.literal('boolean'), prompt: z.string().min(1) });
export const zProgrammaticDim = z.object({
  ...dimBase,
  type: z.literal('programmatic'),
  /** Tool extension UID or built-in assertion name (`assert-output-schema`, `assert-citations-exist`, `assert-exit`). */
  tool: z.string().min(1),
  settings: z.record(z.string(), z.any()).optional(),
});
export const zDimension = z.discriminatedUnion('type', [zNumericDim, zOrdinalDim, zBooleanDim, zProgrammaticDim]);
export type RubricDimension = z.infer<typeof zDimension>;

export const zRubric = z.object({
  schema: z.literal(SCHEMA_TAGS.rubric),
  circuit: zUid,
  judge: z.object({
    subagent: zUid,
    model_id: z.string().min(1),
    provider: z.string().default('bedrock'),
  }),
  dimensions: z.array(zDimension).min(1),
  aggregate: z
    .object({
      method: z.enum(['weighted-mean', 'mean', 'min']).default('weighted-mean'),
      weights: z.record(z.string(), z.number().nonnegative()).prefault({}),
      /** Map ordinal levels to [0,1] for aggregation; default: evenly spaced. */
      ordinal_map: z.record(z.string(), z.record(z.string(), z.number())).optional(),
      gate: z.object({ min: z.number().min(0).max(1) }).optional(),
    })
    .prefault({}),
  required_for_merge: z.boolean().default(false),
});
export type Rubric = z.infer<typeof zRubric>;
