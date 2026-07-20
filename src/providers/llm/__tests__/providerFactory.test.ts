import { describe, expect, it } from 'vitest';

import { FatalError } from '@/core/errors.js';
import type { Config } from '@/core/types.js';
import { AnthropicProvider } from '@/providers/llm/AnthropicProvider.js';
import { GeminiProvider } from '@/providers/llm/GeminiProvider.js';
import { LocalLLMProvider } from '@/providers/llm/LocalLLMProvider.js';
import { OpenAIProvider } from '@/providers/llm/OpenAIProvider.js';
import { OpenRouterProvider } from '@/providers/llm/OpenRouterProvider.js';
import { getProvider } from '@/providers/llm/providerFactory.js';

const BASE_PIPELINE: Config['pipeline'] = {
  backoff: { baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.2 },
  maxImageRetries: 2,
  maxReviewIterations: 3,
  maxConcurrentImageGenerations: 4,
  timeouts: {
    anthropicTimeoutMs: 60_000,
    openAiTimeoutMs: 61_000,
    geminiTimeoutMs: 62_000,
    openRouterTimeoutMs: 63_000,
    localProviderTimeoutMs: 180_000,
  },
};

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    anthropicApiKey: 'anthropic-secret',
    openAiApiKey: 'openai-secret',
    geminiApiKey: 'gemini-secret',
    openRouterApiKey: 'openrouter-secret',
    localEndpointUrl: 'http://localhost:11434',
    models: {
      CHEAP: { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
      STANDARD: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      PREMIUM: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
    },
    imageModel: { provider: 'openai', modelId: 'gpt-image-1' },
    pipeline: BASE_PIPELINE,
    sanityDataset: 'sandbox',
    sanityProjectId: 'project-id',
    sanityWriteToken: 'sanity-secret',
    ...overrides,
  };
}

function configWithTier(
  provider: Config['models']['STANDARD']['provider'],
  modelId: string,
): Config {
  return buildConfig({
    models: {
      CHEAP: { provider, modelId },
      STANDARD: { provider, modelId },
      PREMIUM: { provider, modelId },
    },
  });
}

describe('getProvider', () => {
  it('resolves an AnthropicProvider for the anthropic tier', () => {
    const provider = getProvider('STANDARD', configWithTier('anthropic', 'claude-sonnet-5'));
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('resolves an OpenAIProvider for the openai tier', () => {
    const provider = getProvider('STANDARD', configWithTier('openai', 'gpt-5.6-terra'));
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('resolves a GeminiProvider for the gemini tier', () => {
    const provider = getProvider('STANDARD', configWithTier('gemini', 'gemini-2.5-pro'));
    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('resolves an OpenRouterProvider for the openrouter tier', () => {
    const provider = getProvider(
      'STANDARD',
      configWithTier('openrouter', 'anthropic/claude-sonnet-5'),
    );
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it('resolves a LocalLLMProvider for the local tier', () => {
    const provider = getProvider('STANDARD', configWithTier('local', 'llama-3.1-70b-instruct'));
    expect(provider).toBeInstanceOf(LocalLLMProvider);
  });

  it('is the only switch on provider name — every ModelTier resolves independently', () => {
    const config = buildConfig({
      models: {
        CHEAP: { provider: 'openai', modelId: 'gpt-5.6-luna' },
        STANDARD: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
        PREMIUM: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
      },
    });

    expect(getProvider('CHEAP', config)).toBeInstanceOf(OpenAIProvider);
    expect(getProvider('STANDARD', config)).toBeInstanceOf(AnthropicProvider);
    expect(getProvider('PREMIUM', config)).toBeInstanceOf(GeminiProvider);
  });

  it('accepts an optional tenantId parameter without changing resolution (additive, v1 unused)', () => {
    const config = configWithTier('anthropic', 'claude-sonnet-5');
    expect(getProvider('STANDARD', config, 'tenant-123')).toBeInstanceOf(AnthropicProvider);
  });

  it('throws FatalError when the openai tier is selected but OPENAI_API_KEY is absent', () => {
    const config = configWithTier('openai', 'gpt-5.6-terra');
    expect(() => getProvider('STANDARD', { ...config, openAiApiKey: undefined })).toThrow(
      new FatalError(
        'provider-factory',
        'Missing required environment variable for the configured provider: OPENAI_API_KEY',
      ),
    );
  });

  it('throws FatalError when the gemini tier is selected but GEMINI_API_KEY is absent', () => {
    const config = configWithTier('gemini', 'gemini-2.5-pro');
    expect(() => getProvider('STANDARD', { ...config, geminiApiKey: undefined })).toThrow(
      FatalError,
    );
  });

  it('throws FatalError when the openrouter tier is selected but OPENROUTER_API_KEY is absent', () => {
    const config = configWithTier('openrouter', 'anthropic/claude-sonnet-5');
    expect(() => getProvider('STANDARD', { ...config, openRouterApiKey: undefined })).toThrow(
      FatalError,
    );
  });

  it('throws FatalError when the local tier is selected but LOCAL_LLM_ENDPOINT_URL is absent', () => {
    const config = configWithTier('local', 'llama-3.1-70b-instruct');
    expect(() => getProvider('STANDARD', { ...config, localEndpointUrl: undefined })).toThrow(
      FatalError,
    );
  });
});
