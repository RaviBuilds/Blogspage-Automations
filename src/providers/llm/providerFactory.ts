/**
 * Selects the concrete LLMProvider for one model tier
 * (09-provider-abstraction.md). This is the only place in the codebase where
 * a switch on provider name exists — module code never imports an adapter or
 * an LLM SDK directly, only this factory's return type (LLMProvider).
 */
import { FatalError } from '@/core/errors.js';
import type { Config, ModelTier } from '@/core/types.js';
import { AnthropicProvider } from '@/providers/llm/AnthropicProvider.js';
import { GeminiProvider } from '@/providers/llm/GeminiProvider.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';
import { LocalLLMProvider } from '@/providers/llm/LocalLLMProvider.js';
import { OpenAIProvider } from '@/providers/llm/OpenAIProvider.js';
import { OpenRouterProvider } from '@/providers/llm/OpenRouterProvider.js';

/**
 * Resolves the concrete LLMProvider for `tier`, per `config.models`.
 * `tenantId` is optional and unused in v1 (single-tenant) — its presence now,
 * rather than being added later, is what 18-scalability-and-future-features.md
 * means by "an additive parameter, not a redesign."
 *
 * @throws {FatalError} When the resolved provider's required credential is
 * absent from `config`.
 */
export function getProvider(
  tier: ModelTier,
  config: Config,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future per-tenant model resolution
  tenantId?: string,
): LLMProvider {
  const spec = config.models[tier];

  switch (spec.provider) {
    case 'anthropic':
      return new AnthropicProvider(
        spec.modelId,
        config.anthropicApiKey,
        config.pipeline.timeouts.anthropicTimeoutMs,
      );
    case 'openai':
      return new OpenAIProvider(
        spec.modelId,
        requireCredential(config.openAiApiKey, 'OPENAI_API_KEY'),
        config.pipeline.timeouts.openAiTimeoutMs,
      );
    case 'gemini':
      return new GeminiProvider(
        spec.modelId,
        requireCredential(config.geminiApiKey, 'GEMINI_API_KEY'),
        config.pipeline.timeouts.geminiTimeoutMs,
      );
    case 'openrouter':
      return new OpenRouterProvider(
        spec.modelId,
        requireCredential(config.openRouterApiKey, 'OPENROUTER_API_KEY'),
        config.pipeline.timeouts.openRouterTimeoutMs,
      );
    case 'local':
      return new LocalLLMProvider(
        spec.modelId,
        requireCredential(config.localEndpointUrl, 'LOCAL_LLM_ENDPOINT_URL'),
        config.pipeline.timeouts.localProviderTimeoutMs,
      );
  }
}

function requireCredential(value: string | undefined, environmentKey: string): string {
  if (value === undefined) {
    throw new FatalError(
      'provider-factory',
      `Missing required environment variable for the configured provider: ${environmentKey}`,
    );
  }

  return value;
}
