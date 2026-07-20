/**
 * Gemini adapter for the ImageProvider boundary (09-provider-abstraction.md).
 * Owns every Gemini-specific translation: request shape (Imagen's
 * generateImages call), seed/aspect-ratio mapping, pricing, and error
 * mapping. Nothing Gemini-specific is ever visible outside this file.
 */
import { GoogleGenAI, ApiError as GenAiApiError } from '@google/genai';

import { ProviderError } from '@/core/errors.js';
import { isRetryableStatus } from '@/providers/shared/classifyHttpStatus.js';
import { ProviderHealthTracker } from '@/providers/shared/ProviderStatus.js';
import type { ProviderHealthReporter, ProviderStatus } from '@/providers/shared/ProviderStatus.js';
import type {
  ImageGenerateOptions,
  ImageGenerateResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '@/providers/image/ImageProvider.js';

const PROVIDER_NAME = 'gemini';

/** Updated whenever the pricing table below is re-checked against Gemini's real pricing page. */
const PRICING_VERIFIED_AT = '2026-07-19';

/** USD per image, by model (Imagen is priced per-image, not per-token). */
const PRICING_TABLE: Readonly<Record<string, number>> = Object.freeze({
  'imagen-4-fast': 0.02,
  'imagen-4-standard': 0.04,
  'imagen-4-ultra': 0.06,
});

const DEFAULT_PRICE = 0.04;

function resolvePrice(modelId: string): number {
  return PRICING_TABLE[modelId] ?? DEFAULT_PRICE;
}

/** Gemini's real image-generation adapter (Imagen). Every Gemini SDK type stays inside this file. */
export class GeminiImageProvider implements ImageProvider, ProviderHealthReporter {
  public readonly capabilities: ImageProviderCapabilities = Object.freeze({
    batchGeneration: true,
    editing: false,
    seeded: true,
  });

  private readonly client: GoogleGenAI;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  public async generate(options: ImageGenerateOptions): Promise<ImageGenerateResult> {
    const startedAt = Date.now();

    try {
      const response = await this.client.models.generateImages({
        model: this.modelId,
        prompt: options.prompt,
        config: {
          numberOfImages: options.n ?? 1,
          aspectRatio: options.aspectRatio,
          httpOptions: { timeout: options.timeoutMs ?? this.defaultTimeoutMs },
          ...(options.seed === undefined ? {} : { seed: options.seed }),
        },
      });

      const latencyMs = Date.now() - startedAt;
      this.health.recordSuccess(latencyMs);

      const image = response.generatedImages?.[0]?.image;

      if (image?.imageBytes === undefined) {
        throw new ProviderError(options.moduleKey, PROVIDER_NAME, undefined, false);
      }

      return {
        data: image.imageBytes,
        mimeType: image.mimeType ?? 'image/png',
        costUsd: resolvePrice(this.modelId),
        pricingVerifiedAt: PRICING_VERIFIED_AT,
        providerName: PROVIDER_NAME,
        modelId: this.modelId,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      this.health.recordFailure(latencyMs);
      if (error instanceof ProviderError) {
        throw error;
      }
      throw toProviderError(error, options.moduleKey);
    }
  }

  public getStatus(): ProviderStatus {
    return this.health.getStatus();
  }
}

function toProviderError(error: unknown, moduleKey: string): ProviderError {
  if (error instanceof GenAiApiError) {
    return new ProviderError(
      moduleKey,
      PROVIDER_NAME,
      error.status,
      isRetryableStatus(error.status),
    );
  }

  return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
}
