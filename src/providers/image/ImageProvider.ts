/**
 * The provider-agnostic image-generation boundary (09-provider-abstraction.md).
 * No module under src/modules/ may import an image-generation SDK directly —
 * every module depends only on this interface. This file declares the
 * interface only; it makes no network call and has zero dependency on any
 * concrete adapter.
 */

/** A source image for an 'edit'/'variation' call. Unused for 'generate'. */
export interface ImageSource {
  readonly data: string;
  readonly mimeType: string;
}

/** Options for one ImageProvider.generate() call. */
export interface ImageGenerateOptions {
  readonly moduleKey: string;
  readonly prompt: string;
  readonly aspectRatio: string;
  readonly n?: number;
  readonly seed?: number;
  readonly quality?: 'standard' | 'high';
  readonly style?: string;
  readonly size?: string;
  readonly mode?: 'generate' | 'edit' | 'variation';
  readonly sourceImage?: ImageSource;
  readonly timeoutMs?: number;
}

/** The result of one successful ImageProvider.generate() call. */
export interface ImageGenerateResult {
  readonly data: string;
  readonly mimeType: string;
  readonly costUsd?: number;
  readonly pricingVerifiedAt: string;
  readonly providerName: string;
  readonly modelId: string;
}

/** Capability flags an image adapter must report honestly (09-provider-abstraction.md). */
export interface ImageProviderCapabilities {
  readonly batchGeneration: boolean;
  readonly editing: boolean;
  readonly seeded: boolean;
}

/** The provider-agnostic image-generation boundary every module depends on. */
export interface ImageProvider {
  generate(options: ImageGenerateOptions): Promise<ImageGenerateResult>;
  readonly capabilities: ImageProviderCapabilities;
}

/** The most conservative capability set — used as a fail-closed fallback for unknown models. */
export const FALLBACK_IMAGE_CAPABILITIES: ImageProviderCapabilities = Object.freeze({
  batchGeneration: false,
  editing: false,
  seeded: false,
});
