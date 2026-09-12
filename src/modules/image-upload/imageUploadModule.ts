/**
 * Deterministic Image Upload module — the manual-image consumer (Phase 3, slice 1).
 *
 * Consumes the images a human attached (`images.staged`, written by the
 * `attach-images` gateway — see `src/cli/attachImages.ts` and
 * `21-cost-budget-modes-human-in-loop.md`), sanitizes each file against the
 * image plan, and prepares a content-derived Sanity asset reference for every
 * one. It makes no LLM call and performs no network write: uploading the bytes
 * to Sanity belongs to the publish slice, which re-reads the staged files and
 * overwrites `assetId` with the authoritative `asset._id` returned by
 * `client.assets.upload()`. The deterministic reference gives the manual flow
 * a stable, auditable plan target before any credentials are involved.
 *
 * When nothing is staged the module is a deliberate no-op, so runs configured
 * with `imageSource: 'none'` (or AI-mode runs whose generator has not run yet)
 * pass through it unaffected.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { ValidationError } from '@/core/errors.js';
import {
  defineModule,
  type ModuleExecutionContext,
  type ModuleMetadata,
  type ModuleRegistry,
  type PipelineModule,
} from '@/core/moduleRunner.js';
import type { OrchestratorModuleBinding } from '@/core/orchestrator.js';
import {
  ImagePlanSchema,
  StagedImageSchema,
  UploadedImageSchema,
  type ImagePlan,
  type ImagePlanItem,
  type PipelineState,
  type StagedImage,
  type UploadedImage,
} from '@/core/state.js';
import {
  computeAssetReference,
  readImageMetadata,
  type ImageMetadata,
} from '@/lib/imageHelpers.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';

const IMAGE_UPLOAD_MODULE_KEY = 'image-upload' as const;

/** Services injected by the composition root (uniform across the registry). */
export interface ImageUploadModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface ImageUploadRequest {
  readonly plan: ImagePlan;
  readonly staged: readonly StagedImage[];
}

export const ImageUploadRequestSchema: z.ZodType<ImageUploadRequest> = z
  .object({
    plan: ImagePlanSchema,
    staged: z.array(StagedImageSchema),
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export interface ImageUploadResult {
  readonly uploaded: readonly UploadedImage[];
}

export const ImageUploadResultSchema: z.ZodType<ImageUploadResult> = z
  .object({
    uploaded: z.array(UploadedImageSchema),
  })
  .strict();

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const imageUploadModuleMetadata: ModuleMetadata = Object.freeze({
  key: IMAGE_UPLOAD_MODULE_KEY,
  displayName: 'Image Upload',
  description:
    'Sanitizes human-attached images against the image plan and prepares content-derived Sanity asset references (manual image source).',
  dependencies: Object.freeze(['image-planner'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze(['image-planner.image-plan', 'manual.attached-images']),
    provides: Object.freeze(['image-upload.prepared-uploads']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Image Upload module. */
export function createImageUploadModule(): PipelineModule<
  ImageUploadRequest,
  ImageUploadResult,
  ImageUploadModuleServices
> {
  return defineModule({
    metadata: imageUploadModuleMetadata,
    execute: executeImageUpload,
  });
}

/** Registers one Image Upload module without triggering execution. */
export function registerImageUploadModule(
  registry: ModuleRegistry<ImageUploadModuleServices>,
  module: PipelineModule<
    ImageUploadRequest,
    ImageUploadResult,
    ImageUploadModuleServices
  > = createImageUploadModule(),
): ModuleRegistry<ImageUploadModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Image Upload module. */
export function createImageUploadModuleBinding(): OrchestratorModuleBinding<ImageUploadModuleServices> {
  return Object.freeze({
    key: IMAGE_UPLOAD_MODULE_KEY,
    createInput: (state: PipelineState): ImageUploadRequest => buildImageUploadRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(ImageUploadResultSchema, output, IMAGE_UPLOAD_MODULE_KEY);
      if (result.uploaded.length === 0) {
        // No-op: an empty result must never erase a previous upload record.
        return state;
      }
      return {
        ...state,
        images: {
          ...state.images,
          uploaded: result.uploaded,
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, tolerating a manual flow that has not attached files yet. */
export function buildImageUploadRequest(state: PipelineState): ImageUploadRequest {
  if (state.images?.plan === undefined) {
    throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
      'state.images.plan is required to validate staged images.',
    ]);
  }
  return { plan: state.images.plan, staged: state.images.staged ?? [] };
}

async function executeImageUpload(
  input: ImageUploadRequest,
  _context: ModuleExecutionContext<ImageUploadModuleServices>,
): Promise<ImageUploadResult> {
  const request = assertValid(ImageUploadRequestSchema, input, IMAGE_UPLOAD_MODULE_KEY);
  const uploaded = await prepareUploadedImages(request.plan, request.staged);
  return deepFreeze({ uploaded });
}

/**
 * Sanitizes every staged image against the plan and prepares upload records.
 *
 * @throws {ValidationError} On any staged image that is not a supported image,
 * has no matching plan item, mismatches the plan's role, or has no source.
 */
export async function prepareUploadedImages(
  plan: ImagePlan,
  staged: readonly StagedImage[],
): Promise<readonly UploadedImage[]> {
  const planByImageId = new Map<string, ImagePlanItem>(plan.images.map((item) => [item.id, item]));
  const uploaded: UploadedImage[] = [];

  for (const stagedImage of staged) {
    const planItem = planByImageId.get(stagedImage.imageId);
    if (planItem === undefined) {
      throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
        `Staged image "${stagedImage.imageId}" has no matching entry in images.plan.`,
      ]);
    }
    if (planItem.role !== stagedImage.role) {
      throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
        `Staged image "${stagedImage.imageId}" reports role "${stagedImage.role}" but the plan expects "${planItem.role}".`,
      ]);
    }

    const bytes = await readStagedBytes(stagedImage);
    const metadata = readMetadataWithAttribution(bytes, stagedImage.imageId);
    const altText = planItem.altTextDraft.trim();
    if (altText.length === 0) {
      throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
        `Image "${stagedImage.imageId}" has an empty altTextDraft in the plan.`,
      ]);
    }

    uploaded.push(
      Object.freeze({
        imageId: stagedImage.imageId,
        role: stagedImage.role,
        assetId: computeAssetReference(bytes, metadata),
        altText,
        ...(planItem.placementMarkerId !== undefined
          ? { placementMarkerId: planItem.placementMarkerId }
          : {}),
      }),
    );
  }

  return Object.freeze(uploaded);
}

// ============================================================================
// Internal Helpers
// ============================================================================

async function readStagedBytes(staged: StagedImage): Promise<Uint8Array> {
  const hasLocalPath = staged.localPath !== undefined && staged.localPath.trim().length > 0;
  const hasUrl = staged.url !== undefined && staged.url.trim().length > 0;

  if (hasLocalPath === hasUrl) {
    throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
      `Staged image "${staged.imageId}" must set exactly one of localPath or url.`,
    ]);
  }

  if (hasLocalPath) {
    try {
      const bytes = await readFile(staged.localPath);
      return new Uint8Array(bytes);
    } catch (error) {
      throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
        `Staged image "${staged.imageId}" localPath could not be read: ${errorMessage(error)}.`,
      ]);
    }
  }

  try {
    const response = await fetch(staged.url as string);
    if (!response.ok) {
      throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
        `Staged image "${staged.imageId}" url returned HTTP ${response.status}.`,
      ]);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
      `Staged image "${staged.imageId}" url could not be fetched: ${errorMessage(error)}.`,
    ]);
  }
}

function readMetadataWithAttribution(bytes: Uint8Array, imageId: string): ImageMetadata {
  try {
    return readImageMetadata(bytes);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(IMAGE_UPLOAD_MODULE_KEY, [
        `Staged image "${imageId}" is not a supported image: ${error.message}`,
      ]);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => deepFreeze(item))) as T;
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])),
    ) as T;
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
