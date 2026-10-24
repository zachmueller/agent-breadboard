/**
 * The model gateway ([12] §7, [05] §4): preset resolution, capability-aware fallback walking, cost computation,
 * fallback event log. All LLM traffic flows through here; providers own retry/backoff on throttles.
 */
import { BreadboardError, validationFailed, type PresetEntry, type Presets } from '@breadboard/shared';
import type { ModelCapabilities, ModelGateway, ModelProvider, ModelRequest, ModelResponse } from '../core/services.js';
import type { Logger } from '../core/logger.js';
import { ProviderUnavailableError, errorMessage, isProviderUnavailable } from './errors.js';
import { computeCost } from './pricing.js';

export interface FallbackEvent {
  at: string;
  from: string;
  to: string;
  reason: string;
}

export interface ModelGatewayDeps {
  providers: ModelProvider[];
  /** Presets at a config commit (default main): a branch run resolves tiers from its own commit. */
  presets: (commit?: string) => Promise<Presets>;
  log: Logger;
  onFallback?: (e: FallbackEvent & { session_id?: string; step_id?: string }) => void;
}

type Capability = NonNullable<ModelRequest['requires']>[number];

interface Candidate {
  provider: string;
  model_id: string;
  pricing?: PresetEntry['pricing'];
  /** Capabilities the preset entry declares for this model (augment provider heuristics). */
  declared?: Capability[];
}

export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const MAX_FALLBACK_EVENTS = 100;

export class ModelGatewayImpl implements ModelGateway {
  private readonly byName = new Map<string, ModelProvider>();
  private readonly events: FallbackEvent[] = [];

  constructor(private readonly deps: ModelGatewayDeps) {
    if (!deps.providers.length) throw new Error('model gateway requires at least one provider');
    for (const p of deps.providers) this.byName.set(p.name, p);
  }

  providers(): string[] {
    return [...this.byName.keys()];
  }

  /** Mock-only deployments (dev/tests) route every entry to the mock so bedrock-flavoured presets still work. */
  private get mockOnly(): boolean {
    return this.byName.size === 1 && this.byName.has('mock');
  }

  private get defaultProvider(): string {
    return this.deps.providers[0]!.name;
  }

  private provider(name: string): ModelProvider {
    const p = this.byName.get(name);
    if (!p) throw validationFailed(`unknown model provider '${name}' (installed: ${this.providers().join(', ')})`);
    return p;
  }

  /** Map a configured provider name to an installed one (mock-only substitution), or null when not installed. */
  private installed(name: string | undefined): string | null {
    const n = name ?? this.defaultProvider;
    if (this.byName.has(n)) return n;
    if (this.mockOnly) return 'mock';
    return null;
  }

  capabilities(provider: string, modelId: string): ModelCapabilities {
    return this.provider(this.installed(provider) ?? provider).capabilities(modelId);
  }

  private satisfies(c: Candidate, requires: Capability[]): boolean {
    if (!requires.length) return true;
    const caps = this.provider(c.provider).capabilities(c.model_id);
    return requires.every((r) => caps[r] === true || (c.declared?.includes(r) ?? false));
  }

  /** Ordered candidates before capability filtering. */
  private async candidates(preset: string, overrides?: Record<string, string> | null, commit?: string | null): Promise<Candidate[]> {
    const presets = await this.deps.presets(commit ?? undefined);
    const entries = presets.presets[preset];
    const override = overrides?.[preset];
    if (override) {
      // Prefer the entry (anywhere in the presets file) that names this model, for provider + pricing.
      const known = Object.values(presets.presets).flat().find((e) => e.model_id === override);
      const provider = this.installed(known?.provider ?? entries?.[0]?.provider);
      if (!provider) throw validationFailed(`model override '${override}' for preset '${preset}' has no installed provider`);
      return [{ provider, model_id: override, pricing: known?.pricing, declared: known?.requires }];
    }
    if (!entries?.length) throw validationFailed(`unknown model preset '${preset}'`);
    const out: Candidate[] = [];
    const unknown: string[] = [];
    for (const e of entries) {
      const provider = this.installed(e.provider);
      if (!provider) {
        unknown.push(e.provider);
        continue;
      }
      out.push({ provider, model_id: e.model_id, pricing: e.pricing, declared: e.requires });
    }
    if (!out.length) throw validationFailed(`preset '${preset}' only names uninstalled providers: ${[...new Set(unknown)].join(', ')}`);
    if (unknown.length) this.deps.log.warn({ preset, unknown }, 'preset entries reference uninstalled providers; skipped');
    return out;
  }

  async resolvePreset(preset: string, requires?: ModelRequest['requires'], overrides?: Record<string, string> | null, commit?: string | null): Promise<Array<{ provider: string; model_id: string }>> {
    const all = await this.candidates(preset, overrides, commit);
    return all.filter((c) => this.satisfies(c, requires ?? [])).map(({ provider, model_id }) => ({ provider, model_id }));
  }

  private requirementsFor(req: ModelRequest): Capability[] {
    const set = new Set<Capability>(req.requires ?? []);
    if (req.tools?.length) set.add('tool-use');
    return [...set];
  }

  private recordFallback(e: FallbackEvent, req: ModelRequest): void {
    this.events.push(e);
    if (this.events.length > MAX_FALLBACK_EVENTS) this.events.splice(0, this.events.length - MAX_FALLBACK_EVENTS);
    this.deps.log.warn({ ...e, session_id: req.session_id, step_id: req.step_id }, 'model fallback');
    try {
      this.deps.onFallback?.({ ...e, session_id: req.session_id, step_id: req.step_id });
    } catch (err) {
      this.deps.log.error({ err: errorMessage(err) }, 'onFallback hook threw');
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const requires = this.requirementsFor(req);
    let candidates: Candidate[];
    if (req.model_id) {
      if (req.provider && !this.byName.has(req.provider) && !this.mockOnly) throw validationFailed(`unknown model provider '${req.provider}' (installed: ${this.providers().join(', ')})`);
      const provider = this.installed(req.provider);
      if (!provider) throw validationFailed(`unknown model provider '${req.provider}'`);
      candidates = [{ provider, model_id: req.model_id }];
    } else if (req.preset) {
      candidates = await this.candidates(req.preset, req.model_overrides, req.config_commit);
    } else {
      throw validationFailed('model request needs a preset or model_id');
    }

    const eligible = candidates.filter((c) => this.satisfies(c, requires));
    if (!eligible.length) {
      throw validationFailed(`no model in ${req.model_id ? `'${req.model_id}'` : `preset '${req.preset}'`} satisfies required capabilities [${requires.join(', ')}]`, {
        candidates: candidates.map((c) => `${c.provider}:${c.model_id}`),
      });
    }

    let fallbackFrom: string | null = null;
    let lastErr: unknown = null;
    let allUnavailable = true;
    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i]!;
      const provider = this.provider(c.provider);
      try {
        const started = Date.now();
        const res = await provider.invoke({ ...req, provider: c.provider, model_id: c.model_id });
        const cost = c.pricing ? computeCost(c.pricing, res.usage) : provider.cost(res.model_id || c.model_id, res.usage);
        this.deps.log.debug(
          { session_id: req.session_id, step_id: req.step_id, provider: c.provider, model_id: res.model_id, usage: res.usage, cost_usd: cost, stop_reason: res.stop_reason },
          'model call',
        );
        // Mutate rather than copy so the provider message object (and any non-enumerable replay data) survives.
        return Object.assign(res, { cost_usd: cost, fallback_from: fallbackFrom, latency_ms: res.latency_ms || Date.now() - started });
      } catch (e) {
        if (e instanceof BreadboardError && !isProviderUnavailable(e) && e.code === 'budget-exceeded') throw e;
        lastErr = e;
        if (!isProviderUnavailable(e)) allUnavailable = false;
        const next = eligible[i + 1];
        const reason = errorMessage(e);
        if (next) {
          fallbackFrom ??= c.model_id;
          this.recordFallback({ at: new Date().toISOString(), from: `${c.provider}:${c.model_id}`, to: `${next.provider}:${next.model_id}`, reason }, req);
        } else {
          this.deps.log.error({ provider: c.provider, model_id: c.model_id, err: reason, session_id: req.session_id }, 'model call failed; no fallback left');
        }
      }
    }
    if (allUnavailable) {
      const last = eligible[eligible.length - 1]!;
      throw new ProviderUnavailableError(last.provider, last.model_id, `all ${eligible.length} candidate model(s) unavailable; last: ${errorMessage(lastErr)}`, lastErr);
    }
    throw lastErr;
  }

  async embed(texts: string[]): Promise<{ model_id: string; vectors: number[][] }> {
    const presets = await this.deps.presets();
    const entry = presets.embeddings;
    const providerName = this.mockOnly ? 'mock' : (this.installed(entry?.provider ?? (this.byName.has('bedrock') ? 'bedrock' : this.defaultProvider)) ?? entry?.provider ?? 'bedrock');
    const modelId = entry?.model_id ?? DEFAULT_EMBEDDING_MODEL;
    const provider = this.provider(providerName);
    if (!provider.embed) throw validationFailed(`provider '${providerName}' does not support embeddings`);
    if (!texts.length) return { model_id: modelId, vectors: [] };
    const vectors = await provider.embed(modelId, texts);
    return { model_id: modelId, vectors };
  }

  fallbackEvents(): FallbackEvent[] {
    return [...this.events];
  }
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGatewayImpl {
  return new ModelGatewayImpl(deps);
}
