/**
 * Selects the concrete ImageProvider for the configured image model
 * (09-provider-abstraction.md). This is the only place in the codebase where
 * a switch on image-provider name exists — module code never imports an
 * adapter or an image-generation SDK directly, only this factory's return
 * type (ImageProvider).
 */
import { FatalError } from '@/core/errors.js';
import type { Config } from '@/core/types.js';
import { GeminiImageProvider } from '@/providers/image/GeminiImageProvider.js';
import type { ImageProvider } from '@/providers/image/ImageProvider.js';
import { OpenAIImageProvider } from '@/providers/image/OpenAIImageProvider.js';

/**
 * Resolves the concrete ImageProvider, per `config.imageModel`.
 *
 * @throws {FatalError} When the resolved provider's required credential is
 * absent from `config`.
 */
export function getImageProvider(config: Config): ImageProvider {
  const spec = config.imageModel;

  switch (spec.provider) {
    case 'openai':
      return new OpenAIImageProvider(
        spec.modelId,
        requireCredential(config.openAiApiKey, 'OPENAI_API_KEY'),
        config.pipeline.timeouts.openAiTimeoutMs,
      );
    case 'gemini':
      return new GeminiImageProvider(
        spec.modelId,
        requireCredential(config.geminiApiKey, 'GEMINI_API_KEY'),
        config.pipeline.timeouts.geminiTimeoutMs,
      );
  }
}

function requireCredential(value: string | undefined, environmentKey: string): string {
  if (value === undefined) {
    throw new FatalError(
      'image-provider-factory',
      `Missing required environment variable for the configured image provider: ${environmentKey}`,
    );
  }

  return value;
}
