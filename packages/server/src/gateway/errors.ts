import { BreadboardError } from '@breadboard/shared';

/**
 * A model is unavailable right now (throttled after retries, service outage, model not ready, deprecated / not
 * enabled in the account). The gateway treats this as the signal to walk to the next preset entry ([05] §4).
 */
export class ProviderUnavailableError extends BreadboardError {
  readonly provider: string;
  readonly model_id: string;
  readonly reason: string;
  constructor(provider: string, modelId: string, reason: string, cause?: unknown) {
    super('internal', `model ${provider}:${modelId} unavailable: ${reason}`, { provider, model_id: modelId, reason });
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.model_id = modelId;
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function isProviderUnavailable(e: unknown): e is ProviderUnavailableError {
  return e instanceof ProviderUnavailableError || (e as { name?: string } | null)?.name === 'ProviderUnavailableError';
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
