/**
 * A scripted ImageProvider test double (10-testing-strategy.md). Used by
 * module unit tests to exercise moduleRunner/module logic without a real
 * provider call. Never used in production code.
 */
import type {
  ImageGenerateOptions,
  ImageGenerateResult,
  ImageProvider,
  ImageProviderCapabilities,
} from '@/providers/image/ImageProvider.js';

/** Construction options for FakeImageProvider. */
export interface FakeImageProviderOptions {
  readonly data?: string;
  readonly mimeType?: string;
  readonly costUsd?: number;
  readonly capabilities?: ImageProviderCapabilities;
  readonly throws?: Error;
}

const DEFAULT_CAPABILITIES: ImageProviderCapabilities = Object.freeze({
  batchGeneration: false,
  editing: false,
  seeded: false,
});

/** A scripted, deterministic ImageProvider double for unit tests. */
export class FakeImageProvider implements ImageProvider {
  public readonly capabilities: ImageProviderCapabilities;
  public readonly calls: ImageGenerateOptions[] = [];

  public constructor(private readonly options: FakeImageProviderOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  }

  public generate(options: ImageGenerateOptions): Promise<ImageGenerateResult> {
    this.calls.push(options);

    if (this.options.throws !== undefined) {
      return Promise.reject(this.options.throws);
    }

    return Promise.resolve({
      data: this.options.data ?? '',
      mimeType: this.options.mimeType ?? 'image/png',
      costUsd: this.options.costUsd ?? 0,
      pricingVerifiedAt: '2026-01-01',
      providerName: 'fake',
      modelId: 'fake-image-model',
    });
  }
}
