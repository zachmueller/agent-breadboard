/**
 * Model pricing table (USD per 1M tokens) powering per-turn cost capture ([02] §6, [12] §7).
 *
 * Values are list prices at the time of writing. Claude rows use Anthropic's first-party per-token rates as the
 * reference; Bedrock (especially regional / cross-region inference profiles) can price differently, so teams that
 * need exact accounting override per preset entry via `pricing` in `presets/models.yaml`.
 * Unknown models fall back to a deliberately conservative (high) default so budgets fail safe.
 *
 * Prompt-cache rates: when a row or override sets no `cache_read_per_m` / `cache_write_per_m`, they derive from the
 * input rate (reads 0.1×, writes 1.25× — the 5-minute-TTL write premium).
 */
import type { TokenUsage } from '../core/services.js';

export interface ModelPrice {
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m?: number;
  cache_write_per_m?: number;
}

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Conservative fallback for unknown models: over-estimates spend rather than under-estimating it. */
export const DEFAULT_PRICE: Readonly<ModelPrice> = Object.freeze({ input_per_m: 15, output_per_m: 75 });

interface PriceRow {
  label: string;
  /** Matched against the normalized model id; first match wins (order specific → general). */
  match: RegExp;
  price: ModelPrice;
}

const p = (input_per_m: number, output_per_m: number, cache_read_per_m?: number): ModelPrice => ({ input_per_m, output_per_m, ...(cache_read_per_m !== undefined ? { cache_read_per_m } : {}) });

export const PRICING: readonly PriceRow[] = [
  // --- Anthropic Claude -------------------------------------------------------------------------
  { label: 'Claude Fable 5.1', match: /claude-fable-5-1/, price: p(10, 50, 0.25) },
  { label: 'Claude Mythos 5.1', match: /claude-mythos-5-1/, price: p(10, 50, 0.25) },
  { label: 'Claude Fable 5', match: /claude-fable-5/, price: p(10, 50) },
  { label: 'Claude Mythos 5', match: /claude-mythos-5/, price: p(10, 50) },
  { label: 'Claude Opus 5.5', match: /claude-opus-5-5/, price: p(4, 20, 0.2) },
  { label: 'Claude Opus 5', match: /claude-opus-5/, price: p(5, 25) },
  { label: 'Claude Sonnet 5.5', match: /claude-sonnet-5-5/, price: p(2, 10) },
  { label: 'Claude Sonnet 5', match: /claude-sonnet-5/, price: p(2, 10) },
  { label: 'Claude Opus 4.5-4.8', match: /claude-opus-4-[5-8]/, price: p(5, 25) },
  { label: 'Claude Opus 4 / 4.1', match: /claude-opus-4/, price: p(15, 75) },
  { label: 'Claude Sonnet 4.x', match: /claude-sonnet-4/, price: p(3, 15) },
  { label: 'Claude Haiku 4.5', match: /claude-haiku-4-5/, price: p(1, 5) },
  { label: 'Claude 3.7 / 3.5 Sonnet', match: /claude-3-[57]-sonnet/, price: p(3, 15) },
  { label: 'Claude 3.5 Haiku', match: /claude-3-5-haiku/, price: p(0.8, 4) },
  { label: 'Claude 3 Haiku', match: /claude-3-haiku/, price: p(0.25, 1.25) },
  { label: 'Claude 3 Opus', match: /claude-3-opus/, price: p(15, 75) },
  // --- Amazon Nova --------------------------------------------------------------------------------
  { label: 'Amazon Nova 2 Lite', match: /nova-2-lite|nova-lite-v2/, price: p(0.3, 2.5) },
  { label: 'Amazon Nova Micro', match: /nova-micro/, price: p(0.035, 0.14) },
  { label: 'Amazon Nova Lite', match: /nova-lite/, price: p(0.06, 0.24) },
  { label: 'Amazon Nova Pro', match: /nova-pro/, price: p(0.8, 3.2) },
  { label: 'Amazon Nova Premier', match: /nova-premier/, price: p(2.5, 12.5) },
  // --- Meta Llama ---------------------------------------------------------------------------------
  { label: 'Llama 4 Maverick', match: /llama4-maverick/, price: p(0.24, 0.97) },
  { label: 'Llama 4 Scout', match: /llama4-scout/, price: p(0.17, 0.66) },
  { label: 'Llama 3.3 70B', match: /llama3-3-70b/, price: p(0.72, 0.72) },
  { label: 'Llama 3.2 90B', match: /llama3-2-90b/, price: p(0.72, 0.72) },
  { label: 'Llama 3.2 11B', match: /llama3-2-11b/, price: p(0.16, 0.16) },
  { label: 'Llama 3.2 3B', match: /llama3-2-3b/, price: p(0.15, 0.15) },
  { label: 'Llama 3.2 1B', match: /llama3-2-1b/, price: p(0.1, 0.1) },
  { label: 'Llama 3.1 405B', match: /llama3-1-405b/, price: p(2.4, 2.4) },
  { label: 'Llama 3.1 70B', match: /llama3-1-70b/, price: p(0.72, 0.72) },
  { label: 'Llama 3.1 8B', match: /llama3-1-8b/, price: p(0.22, 0.22) },
  { label: 'Llama 3 70B', match: /llama3-70b/, price: p(2.65, 3.5) },
  { label: 'Llama 3 8B', match: /llama3-8b/, price: p(0.3, 0.6) },
  // --- Mistral ------------------------------------------------------------------------------------
  { label: 'Pixtral Large', match: /pixtral-large/, price: p(2, 6) },
  { label: 'Mistral Large 2 (2407)', match: /mistral-large-2407/, price: p(2, 6) },
  { label: 'Mistral Large (2402)', match: /mistral-large/, price: p(4, 12) },
  { label: 'Mistral Small', match: /mistral-small/, price: p(1, 3) },
  { label: 'Mixtral 8x7B', match: /mixtral-8x7b/, price: p(0.45, 0.7) },
  { label: 'Mistral 7B', match: /mistral-7b/, price: p(0.15, 0.2) },
  // --- Embeddings (input-only) --------------------------------------------------------------------
  { label: 'Cohere Embed v4', match: /cohere\.embed-v4/, price: p(0.12, 0) },
  { label: 'Cohere Embed v3', match: /cohere\.embed-/, price: p(0.1, 0) },
  { label: 'Titan Text Embeddings v2', match: /titan-embed-text-v2/, price: p(0.02, 0) },
  { label: 'Titan Embeddings G1', match: /titan-embed/, price: p(0.1, 0) },
];

const REGION_PREFIX = /^(?:us|eu|apac|global|jp|au|ca|us-gov)\./;

/**
 * Normalize a Bedrock model reference for table lookup: strips ARNs (`…/inference-profile/us.anthropic…`) and
 * cross-region inference-profile prefixes (`us.`, `eu.`, `global.`…), lower-cases.
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  if (id.startsWith('arn:')) id = id.slice(id.lastIndexOf('/') + 1);
  return id.replace(REGION_PREFIX, '');
}

/** Table price for a model, or null when the model is unknown. */
export function lookupPrice(modelId: string): ModelPrice | null {
  const id = normalizeModelId(modelId);
  for (const row of PRICING) if (row.match.test(id)) return row.price;
  return null;
}

/** Effective price: explicit override (preset `pricing`) → table → conservative default. */
export function priceFor(modelId: string, override?: ModelPrice | null): ModelPrice {
  return override ?? lookupPrice(modelId) ?? DEFAULT_PRICE;
}

/** Every token the model processed (uncached + cached input, output): what token budgets count. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.output_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
}

export function computeCost(price: ModelPrice, usage: TokenUsage): number {
  const read = price.cache_read_per_m ?? price.input_per_m * CACHE_READ_MULTIPLIER;
  const write = price.cache_write_per_m ?? price.input_per_m * CACHE_WRITE_MULTIPLIER;
  const usd =
    (usage.input_tokens * price.input_per_m + usage.output_tokens * price.output_per_m + (usage.cache_read_tokens ?? 0) * read + (usage.cache_write_tokens ?? 0) * write) / 1_000_000;
  // Round to micro-dollars to keep sums stable in logs/DB.
  return Math.round(usd * 1e6) / 1e6;
}

/** TokenUsage → the `session_turns` token columns (null when the turn reported no usage). */
export function usageColumns(usage: TokenUsage | null | undefined): { tokens_in: number | null; tokens_out: number | null; tokens_cache_read: number | null; tokens_cache_write: number | null } {
  return {
    tokens_in: usage?.input_tokens ?? null,
    tokens_out: usage?.output_tokens ?? null,
    tokens_cache_read: usage?.cache_read_tokens ?? null,
    tokens_cache_write: usage?.cache_write_tokens ?? null,
  };
}
