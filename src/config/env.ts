import { DEFAULT_MODELS } from '@/config/models.js';
import { DEFAULT_PIPELINE_CONFIG } from '@/config/pipeline.js';
import { FatalError } from '@/core/errors.js';
import type { Config } from '@/core/types.js';

const REQUIRED_ENVIRONMENT_KEYS = [
  'SANITY_PROJECT_ID',
  'SANITY_DATASET',
  'SANITY_WRITE_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

type RequiredEnvironmentKey = (typeof REQUIRED_ENVIRONMENT_KEYS)[number];

/**
 * Loads and validates the process environment once at application startup.
 * Modules must receive this result through their dependencies and never read
 * process.env directly.
 *
 * @throws {FatalError} When a required variable is missing or blank.
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const values = Object.fromEntries(
    REQUIRED_ENVIRONMENT_KEYS.map((key) => [key, readRequiredValue(environment, key)]),
  ) as Record<RequiredEnvironmentKey, string>;

  return Object.freeze({
    anthropicApiKey: values.ANTHROPIC_API_KEY,
    models: DEFAULT_MODELS,
    pipeline: DEFAULT_PIPELINE_CONFIG,
    sanityDataset: values.SANITY_DATASET,
    sanityProjectId: values.SANITY_PROJECT_ID,
    sanityWriteToken: values.SANITY_WRITE_TOKEN,
  });
}

function readRequiredValue(environment: NodeJS.ProcessEnv, key: RequiredEnvironmentKey): string {
  const value = environment[key]?.trim();

  if (value === undefined || value.length === 0) {
    throw new FatalError('config', `Missing required environment variable: ${key}`);
  }

  return value;
}

/** Exposed for tests and tooling that verify .env.example stays synchronized. */
export const requiredEnvironmentKeys: readonly RequiredEnvironmentKey[] = REQUIRED_ENVIRONMENT_KEYS;
