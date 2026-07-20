import type { ImageModelSpec, ModelsConfig } from '@/core/types.js';

/**
 * Default tier-to-model mapping. Modules select a tier only; provider and
 * model selection remain a centralized configuration concern. OpenAI is the
 * configured default provider for this project (an available API key), per
 * 09-provider-abstraction.md's "provider/model choice is a config change"
 * principle — swapping this to another provider never requires a module or
 * adapter code change.
 */
export const DEFAULT_MODELS: ModelsConfig = Object.freeze({
  CHEAP: Object.freeze({
    provider: 'openai',
    modelId: 'gpt-5.6-luna',
  }),
  STANDARD: Object.freeze({
    provider: 'openai',
    modelId: 'gpt-5.6-terra',
  }),
  PREMIUM: Object.freeze({
    provider: 'openai',
    modelId: 'gpt-5.6-sol',
  }),
});

/** Default image-generation provider and model. */
export const DEFAULT_IMAGE_MODEL: ImageModelSpec = Object.freeze({
  provider: 'openai',
  modelId: 'gpt-image-1',
});
