import { z } from 'zod';
import { SCHEMA_TAGS } from './common.js';

export const MODEL_CAPABILITIES = ['tool-use', 'structured-output', 'streaming', 'embeddings', 'vision'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const zPresetEntry = z.object({
  provider: z.string().min(1).default('bedrock'),
  model_id: z.string().min(1),
  requires: z.array(z.enum(MODEL_CAPABILITIES)).optional(),
  /** Optional per-model price override (USD per 1M tokens). Gateway defaults apply otherwise. */
  pricing: z.object({ input_per_m: z.number().nonnegative(), output_per_m: z.number().nonnegative() }).optional(),
});
export type PresetEntry = z.infer<typeof zPresetEntry>;

export const zPresets = z.object({
  schema: z.literal(SCHEMA_TAGS.presets),
  presets: z.record(z.string(), z.array(zPresetEntry).min(1)),
  /** Preset used for embeddings ([07] §9). */
  embeddings: zPresetEntry.optional(),
});
export type Presets = z.infer<typeof zPresets>;
