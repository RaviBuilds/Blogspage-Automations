import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FatalError } from '@/core/errors.js';
import { loadConfig, optionalEnvironmentKeys, requiredEnvironmentKeys } from '@/config/env.js';

const VALID_ENVIRONMENT = {
  ANTHROPIC_API_KEY: 'anthropic-secret',
  OPENAI_API_KEY: 'openai-secret',
  SANITY_DATASET: 'sandbox',
  SANITY_PROJECT_ID: 'project-id',
  SANITY_WRITE_TOKEN: 'sanity-secret',
};

describe('loadConfig', () => {
  it('loads and freezes a typed process-level configuration', () => {
    const config = loadConfig(VALID_ENVIRONMENT);

    expect(config).toMatchObject({
      anthropicApiKey: 'anthropic-secret',
      openAiApiKey: 'openai-secret',
      geminiApiKey: undefined,
      openRouterApiKey: undefined,
      localEndpointUrl: undefined,
      sanityDataset: 'sandbox',
      sanityProjectId: 'project-id',
      sanityWriteToken: 'sanity-secret',
      models: {
        CHEAP: { provider: 'openai', modelId: 'gpt-5.6-luna' },
        STANDARD: { provider: 'openai', modelId: 'gpt-5.6-terra' },
        PREMIUM: { provider: 'openai', modelId: 'gpt-5.6-sol' },
      },
      imageModel: { provider: 'openai', modelId: 'gpt-image-1' },
      pipeline: {
        backoff: { baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.2 },
        maxImageRetries: 2,
        maxReviewIterations: 3,
        maxConcurrentImageGenerations: 4,
        timeouts: {
          anthropicTimeoutMs: 60_000,
          openAiTimeoutMs: 60_000,
          geminiTimeoutMs: 60_000,
          openRouterTimeoutMs: 60_000,
          localProviderTimeoutMs: 180_000,
        },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.models)).toBe(true);
    expect(Object.isFrozen(config.models.CHEAP)).toBe(true);
    expect(Object.isFrozen(config.pipeline)).toBe(true);
    expect(Object.isFrozen(config.pipeline.backoff)).toBe(true);
    expect(Object.isFrozen(config.pipeline.timeouts)).toBe(true);
  });

  it('resolves optional provider credentials when present', () => {
    const config = loadConfig({
      ...VALID_ENVIRONMENT,
      GEMINI_API_KEY: 'gemini-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      LOCAL_LLM_ENDPOINT_URL: 'http://localhost:11434',
    });

    expect(config.geminiApiKey).toBe('gemini-secret');
    expect(config.openRouterApiKey).toBe('openrouter-secret');
    expect(config.localEndpointUrl).toBe('http://localhost:11434');
  });

  it.each(optionalEnvironmentKeys)('treats blank %s the same as absent', (key) => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, [key]: '   ' });

    expect(
      config.geminiApiKey ?? config.openRouterApiKey ?? config.localEndpointUrl,
    ).toBeUndefined();
  });

  it.each(requiredEnvironmentKeys)('throws FatalError when %s is absent', (key) => {
    const environment = { ...VALID_ENVIRONMENT };
    delete environment[key];

    expect(() => loadConfig(environment)).toThrow(
      new FatalError('config', `Missing required environment variable: ${key}`),
    );
  });

  it.each(requiredEnvironmentKeys)('throws FatalError when %s is blank', (key) => {
    expect(() => loadConfig({ ...VALID_ENVIRONMENT, [key]: '  ' })).toThrow(
      new FatalError('config', `Missing required environment variable: ${key}`),
    );
  });

  it('keeps the runtime requirements synchronized with .env.example', async () => {
    const environmentExample = await readFile(resolve(process.cwd(), '.env.example'), 'utf8');

    for (const key of requiredEnvironmentKeys) {
      expect(environmentExample).toMatch(new RegExp(`^${key}=`, 'm'));
    }

    for (const key of optionalEnvironmentKeys) {
      expect(environmentExample).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});
