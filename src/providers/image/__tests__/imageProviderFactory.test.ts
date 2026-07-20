import { describe, expect, it } from 'vitest';

import { FatalError } from '@/core/errors.js';
import type { Config } from '@/core/types.js';
import { GeminiImageProvider } from '@/providers/image/GeminiImageProvider.js';
import { getImageProvider } from '@/providers/image/imageProviderFactory.js';
import { OpenAIImageProvider } from '@/providers/image/OpenAIImageProvider.js';

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

describe('getImageProvider', () => {
  it('resolves an OpenAIImageProvider for the openai image model', () => {
    const provider = getImageProvider(
      buildConfig({ imageModel: { provider: 'openai', modelId: 'gpt-image-1' } }),
    );
    expect(provider).toBeInstanceOf(OpenAIImageProvider);
  });

  it('resolves a GeminiImageProvider for the gemini image model', () => {
    const provider = getImageProvider(
      buildConfig({ imageModel: { provider: 'gemini', modelId: 'imagen-4-standard' } }),
    );
    expect(provider).toBeInstanceOf(GeminiImageProvider);
  });

  it('throws FatalError when openai is configured but OPENAI_API_KEY is absent', () => {
    const config = buildConfig({
      imageModel: { provider: 'openai', modelId: 'gpt-image-1' },
      openAiApiKey: undefined,
    });

    expect(() => getImageProvider(config)).toThrow(
      new FatalError(
        'image-provider-factory',
        'Missing required environment variable for the configured image provider: OPENAI_API_KEY',
      ),
    );
  });

  it('throws FatalError when gemini is configured but GEMINI_API_KEY is absent', () => {
    const config = buildConfig({
      imageModel: { provider: 'gemini', modelId: 'imagen-4-standard' },
      geminiApiKey: undefined,
    });

    expect(() => getImageProvider(config)).toThrow(FatalError);
  });
});
