import type { ModelsConfig } from '@/core/types.js';

/**
 * Default tier-to-model mapping. Modules select a tier only; provider and
 * model selection remain a centralized configuration concern.
 */
export const DEFAULT_MODELS: ModelsConfig = Object.freeze({
  CHEAP: Object.freeze({
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
  }),
  STANDARD: Object.freeze({
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
  }),
  PREMIUM: Object.freeze({
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
  }),
});
