/** Model gateway ([12] §7): provider abstraction, preset fallback walking, pricing. */
import type { Env } from '../core/env.js';
import type { Logger } from '../core/logger.js';
import type { ModelProvider } from '../core/services.js';
import { BedrockProvider } from './bedrock.js';
import { MockProvider } from './mock.js';

export { ModelGatewayImpl, createModelGateway, DEFAULT_EMBEDDING_MODEL, type FallbackEvent, type ModelGatewayDeps } from './gateway.js';
export { BedrockProvider, bedrockCapabilities, toConverseRequest, toConverseMessages, fromConverseResponse, classifyBedrockError, mapStopReason, modelFamily, supportsForcedToolChoice, type BedrockProviderOptions, type BedrockSendClient } from './bedrock.js';
export { MockProvider, FINISH_TOOL_NAME, MOCK_EMBED_DIMS, mockEmbedding, synthesizeFromSchema, type MockReply, type MockScriptFn, type MockProviderOptions } from './mock.js';
export { ProviderUnavailableError, isProviderUnavailable } from './errors.js';
export { PRICING, DEFAULT_PRICE, computeCost, lookupPrice, priceFor, normalizeModelId, type ModelPrice } from './pricing.js';

/**
 * Providers for the configured mode. `bedrock` → [Bedrock, Mock] (the mock stays registered so presets naming
 * `provider: mock` keep working in dev); `mock` → [Mock] (every preset entry is routed to the mock).
 */
export function createProviders(env: Pick<Env, 'MODEL_PROVIDER' | 'AWS_REGION' | 'BEDROCK_ENDPOINT'>, log?: Logger): ModelProvider[] {
  if (env.MODEL_PROVIDER === 'bedrock') {
    return [new BedrockProvider({ region: env.AWS_REGION, endpoint: env.BEDROCK_ENDPOINT, log }), new MockProvider()];
  }
  return [new MockProvider()];
}
