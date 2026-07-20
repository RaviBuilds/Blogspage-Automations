import { DEFAULT_IMAGE_MODEL, DEFAULT_MODELS } from '@/config/models.js';
import { DEFAULT_PIPELINE_CONFIG } from '@/config/pipeline.js';
import { FatalError } from '@/core/errors.js';
import type { Config } from '@/core/types.js';

const REQUIRED_ENVIRONMENT_KEYS = [
  'SANITY_PROJECT_ID',
  'SANITY_DATASET',
  'SANITY_WRITE_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

/**
 * Optional per-provider credentials. Only required when a tier's ModelSpec or
 * the configured image model actually resolves to that provider — v1's
 * DEFAULT_MODELS/DEFAULT_IMAGE_MODEL never resolve to Gemini, OpenRouter, or
 * Local, so these stay optional at the env-loading boundary; providerFactory/
 * imageProviderFactory raise a clear FatalError if a tier is reconfigured to
 * a provider whose credential is absent at that point instead.
 */
const OPTIONAL_ENVIRONMENT_KEYS = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'LOCAL_LLM_ENDPOINT_URL',
] as const;

type RequiredEnvironmentKey = (typeof REQUIRED_ENVIRONMENT_KEYS)[number];
type OptionalEnvironmentKey = (typeof OPTIONAL_ENVIRONMENT_KEYS)[number];

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

  const optionalValues = Object.fromEntries(
    OPTIONAL_ENVIRONMENT_KEYS.map((key) => [key, readOptionalValue(environment, key)]),
  ) as Record<OptionalEnvironmentKey, string | undefined>;

  return Object.freeze({
    anthropicApiKey: values.ANTHROPIC_API_KEY,
    openAiApiKey: values.OPENAI_API_KEY,
    geminiApiKey: optionalValues.GEMINI_API_KEY,
    openRouterApiKey: optionalValues.OPENROUTER_API_KEY,
    localEndpointUrl: optionalValues.LOCAL_LLM_ENDPOINT_URL,
    models: DEFAULT_MODELS,
    imageModel: DEFAULT_IMAGE_MODEL,
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

function readOptionalValue(
  environment: NodeJS.ProcessEnv,
  key: OptionalEnvironmentKey,
): string | undefined {
  const value = environment[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Exposed for tests and tooling that verify .env.example stays synchronized. */
export const requiredEnvironmentKeys: readonly RequiredEnvironmentKey[] = REQUIRED_ENVIRONMENT_KEYS;

/** Exposed for tests and tooling that verify .env.example stays synchronized. */
export const optionalEnvironmentKeys: readonly OptionalEnvironmentKey[] = OPTIONAL_ENVIRONMENT_KEYS;
