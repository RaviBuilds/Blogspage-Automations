/**
 * OpenAI adapter for the ImageProvider boundary (09-provider-abstraction.md).
 * Owns every OpenAI-specific translation: request shape, quality/size/style
 * mapping, pricing, and error mapping. Nothing OpenAI-specific is ever
 * visible outside this file.
 */
import OpenAI from 'openai';

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

const PROVIDER_NAME = 'openai';

/** Updated whenever the pricing table below is re-checked against OpenAI's real pricing page. */
const PRICING_VERIFIED_AT = '2026-07-19';

/** USD per image, by model and quality tier (OpenAI's gpt-image family is priced per-image, not per-token). */
const PRICING_TABLE: Readonly<
  Record<string, { readonly standard: number; readonly high: number }>
> = Object.freeze({
  'gpt-image-1': { standard: 0.04, high: 0.08 },
  'gpt-image-1-mini': { standard: 0.02, high: 0.04 },
});

const DEFAULT_PRICING = { standard: 0.04, high: 0.08 };

function resolvePrice(modelId: string, quality: ImageGenerateOptions['quality']): number {
  const pricing = PRICING_TABLE[modelId] ?? DEFAULT_PRICING;
  return quality === 'high' ? pricing.high : pricing.standard;
}

function toSize(
  aspectRatio: string,
  size: string | undefined,
): '1024x1024' | '1024x1536' | '1536x1024' {
  if (size === '1024x1536' || size === '1536x1024' || size === '1024x1024') {
    return size;
  }

  if (aspectRatio === '9:16') {
    return '1024x1536';
  }

  if (aspectRatio === '16:9') {
    return '1536x1024';
  }

  return '1024x1024';
}

/** OpenAI's real image-generation adapter. Every OpenAI SDK type stays inside this file. */
export class OpenAIImageProvider implements ImageProvider, ProviderHealthReporter {
  public readonly capabilities: ImageProviderCapabilities = Object.freeze({
    batchGeneration: true,
    editing: false,
    seeded: false,
  });

  private readonly client: OpenAI;
  private readonly health = new ProviderHealthTracker(PROVIDER_NAME);

  public constructor(
    private readonly modelId: string,
    apiKey: string,
    private readonly defaultTimeoutMs: number,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  public async generate(options: ImageGenerateOptions): Promise<ImageGenerateResult> {
    const startedAt = Date.now();

    try {
      const response = await this.client.images.generate(
        {
          model: this.modelId,
          prompt: options.prompt,
          n: options.n ?? 1,
          size: toSize(options.aspectRatio, options.size),
          quality: options.quality === 'high' ? 'high' : 'standard',
        },
        { timeout: options.timeoutMs ?? this.defaultTimeoutMs },
      );

      const latencyMs = Date.now() - startedAt;
      this.health.recordSuccess(latencyMs);

      const image = response.data?.[0];
      if (image?.b64_json === undefined) {
        throw new ProviderError(options.moduleKey, PROVIDER_NAME, undefined, false);
      }

      return {
        data: image.b64_json,
        mimeType: 'image/png',
        costUsd: resolvePrice(this.modelId, options.quality),
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
  if (
    error instanceof OpenAI.APIUserAbortError ||
    error instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
  }

  if (error instanceof OpenAI.APIError) {
    const status: number | undefined = typeof error.status === 'number' ? error.status : undefined;
    return new ProviderError(moduleKey, PROVIDER_NAME, status, isRetryableStatus(status));
  }

  return new ProviderError(moduleKey, PROVIDER_NAME, undefined, true);
}
