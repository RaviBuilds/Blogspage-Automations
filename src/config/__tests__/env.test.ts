import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FatalError } from '@/core/errors.js';
import { loadConfig, requiredEnvironmentKeys } from '@/config/env.js';

const VALID_ENVIRONMENT = {
  ANTHROPIC_API_KEY: 'anthropic-secret',
  SANITY_DATASET: 'sandbox',
  SANITY_PROJECT_ID: 'project-id',
  SANITY_WRITE_TOKEN: 'sanity-secret',
};

describe('loadConfig', () => {
  it('loads and freezes a typed process-level configuration', () => {
    const config = loadConfig(VALID_ENVIRONMENT);

    expect(config).toMatchObject({
      anthropicApiKey: 'anthropic-secret',
      sanityDataset: 'sandbox',
      sanityProjectId: 'project-id',
      sanityWriteToken: 'sanity-secret',
      models: {
        CHEAP: { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
        STANDARD: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
        PREMIUM: { provider: 'anthropic', modelId: 'claude-opus-4-8' },
      },
      pipeline: {
        backoff: { baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.2 },
        maxImageRetries: 2,
        maxReviewIterations: 3,
        maxConcurrentImageGenerations: 4,
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.models)).toBe(true);
    expect(Object.isFrozen(config.models.CHEAP)).toBe(true);
    expect(Object.isFrozen(config.pipeline)).toBe(true);
    expect(Object.isFrozen(config.pipeline.backoff)).toBe(true);
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
  });
});
