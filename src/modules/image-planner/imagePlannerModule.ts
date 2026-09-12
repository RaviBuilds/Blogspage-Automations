/**
 * Provider-agnostic Image Planner module (Phase 3, slice 1).
 *
 * Turns the draft's image markers (plus the hero need) into concrete image
 * briefs: subject, composition, aspect ratio, and a draft alt text for each
 * image. It does NOT generate or upload media — the plan feeds the human
 * handoff (`imageSource: 'manual'`) or, for clients, the image generator
 * (`imageSource: 'ai'`). The pipeline previously consumed this plan at
 * `images.plan` (`04-json-contracts.md`); the human-in-the-loop handoff is
 * documented in `21-cost-budget-modes-human-in-loop.md`.
 *
 * Provider invocation, timing, cost-event persistence, scheduling, and
 * checkpointing remain owned by ModuleRunner and PipelineOrchestrator.
 */

import { z } from 'zod';

import { ValidationError } from '@/core/errors.js';
import {
  defineModule,
  type ModuleExecutionContext,
  type ModuleMetadata,
  type ModuleCostEventInput,
  type ModuleRegistry,
  type PipelineModule,
} from '@/core/moduleRunner.js';
import type { OrchestratorModuleBinding } from '@/core/orchestrator.js';
import {
  DraftSectionSchema,
  ImagePlanSchema,
  PlanningSectionSchema,
  type DraftSection,
  type ImagePlan,
  type PipelineState,
  type PlanningSection,
} from '@/core/state.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { ProviderName } from '@/core/types.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const IMAGE_PLANNER_MODULE_KEY = 'image-planner' as const;
const MAX_OUTPUT_TOKENS = 4_000;

/** The site's Open Graph / social-share dimensions (`knowledge/image-system.md`). */
const HERO_ASPECT_RATIO = '1200x630';

const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

// ============================================================================
// Input Contract
// ============================================================================

/** Stable, persisted inputs available to the Image Planner through PipelineState. */
export interface ImagePlannerRequest {
  readonly planning: PlanningSection;
  readonly draft: DraftSection;
}

export const ImagePlannerRequestSchema: z.ZodType<ImagePlannerRequest> = z
  .object({
    planning: PlanningSectionSchema,
    draft: DraftSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

/**
 * The validated plan shape. Validation of structural rules (one hero, inline
 * marker coverage) is intentionally separate from the persisted-state schema
 * so `images.plan` stays the exact `ImagePlan` contract of `04-json-contracts.md`.
 */
export const ImagePlannerResultSchema: z.ZodType<ImagePlan> =
  ImagePlanSchema.superRefine(validatePlanShape);

/** JSON-schema hint passed to providers that support structured output. */
const ImagePlannerResultJsonSchema = z.toJSONSchema(ImagePlanSchema);

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const imagePlannerModuleMetadata: ModuleMetadata = Object.freeze({
  key: IMAGE_PLANNER_MODULE_KEY,
  displayName: 'Image Planner',
  description:
    "Turns the draft's image markers and hero need into concrete image briefs (prompt, aspect ratio, alt text) without generating or uploading media.",
  dependencies: Object.freeze(['planner', 'writer', 'humanizer'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'planner.content-plan',
      'writer.draft',
      'humanizer.humanized-draft',
    ]),
    provides: Object.freeze(['image-planner.image-plan']),
  }),
});

/** Services injected by the composition root. */
export interface ImagePlannerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Image Planner module. */
export function createImagePlannerModule(): PipelineModule<
  ImagePlannerRequest,
  ImagePlan,
  ImagePlannerModuleServices
> {
  return defineModule({
    metadata: imagePlannerModuleMetadata,
    execute: executeImagePlanner,
  });
}

/** Registers one Image Planner module without triggering execution. */
export function registerImagePlannerModule(
  registry: ModuleRegistry<ImagePlannerModuleServices>,
  module: PipelineModule<
    ImagePlannerRequest,
    ImagePlan,
    ImagePlannerModuleServices
  > = createImagePlannerModule(),
): ModuleRegistry<ImagePlannerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Image Planner module. */
export function createImagePlannerModuleBinding(): OrchestratorModuleBinding<ImagePlannerModuleServices> {
  return Object.freeze({
    key: IMAGE_PLANNER_MODULE_KEY,
    createInput: (state: PipelineState): ImagePlannerRequest => buildImagePlannerRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const plan = assertValid(ImagePlannerResultSchema, output, IMAGE_PLANNER_MODULE_KEY);
      return {
        ...state,
        images: {
          ...state.images,
          plan,
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the Image Planner's input, rejecting runs that cannot plan images yet. */
export function buildImagePlannerRequest(state: PipelineState): ImagePlannerRequest {
  if (state.planning === undefined) {
    throw new ValidationError(IMAGE_PLANNER_MODULE_KEY, [
      'state.planning is required to plan images (the article angle).',
    ]);
  }
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(IMAGE_PLANNER_MODULE_KEY, [
      'state.draft.current is required to plan images (the image markers).',
    ]);
  }
  return { planning: state.planning, draft: state.draft };
}

async function executeImagePlanner(
  input: ImagePlannerRequest,
  context: ModuleExecutionContext<ImagePlannerModuleServices>,
): Promise<ImagePlan> {
  const request = normalizeImagePlannerRequest(input);

  // Build the prompt with the draft's image markers and the article angle.
  const prompt = await context.services.promptRegistry.get('image-planner', {
    angle: request.planning.angle,
    imageMarkersAsMarkdownList: formatImageMarkers(request.draft.current.imageMarkers),
  });

  const response = await context.services.llmProvider.complete({
    moduleKey: IMAGE_PLANNER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: ImagePlannerResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const plan = deepFreeze(
      parseJsonWithSchema(response.text, ImagePlannerResultSchema, IMAGE_PLANNER_MODULE_KEY),
    );
    assertMarkerCoverage(plan, request.draft.current.imageMarkers);
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return plan;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

export function normalizeImagePlannerRequest(input: ImagePlannerRequest): ImagePlannerRequest {
  return assertValid(ImagePlannerRequestSchema, input, IMAGE_PLANNER_MODULE_KEY);
}

/** Renders the draft's image markers as the prompt's markdown list. */
export function formatImageMarkers(
  markers: readonly {
    readonly markerId: string;
    readonly role: 'hero' | 'inline';
    readonly descriptionHint: string;
  }[],
): string {
  if (markers.length === 0) {
    return '- None';
  }
  return markers
    .map(
      (marker) => `- [${marker.role.toUpperCase()}] ${marker.markerId}: ${marker.descriptionHint}`,
    )
    .join('\n');
}

/** Structural plan rules that don't need the draft's marker list. */
function validatePlanShape(plan: ImagePlan, ctx: z.RefinementCtx): void {
  const items = plan.images;
  if (items.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Plan must include at least one image (the hero).',
    });
    return;
  }

  const heroes = items.filter((item) => item.role === 'hero');
  if (heroes.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Plan must contain exactly one hero image; found ${heroes.length}.`,
    });
  } else if ((heroes[0]?.aspectRatio ?? '') !== HERO_ASPECT_RATIO) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Hero image aspectRatio must be "${HERO_ASPECT_RATIO}" (Open Graph dimensions).`,
    });
  }

  const seenPlacementMarkers = new Set<string>();
  const duplicates: string[] = [];

  for (const item of items) {
    if (item.prompt.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Image "${item.id}" has an empty generation prompt.`,
      });
    }
    if (item.altTextDraft.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Image "${item.id}" has an empty altTextDraft.`,
      });
    }
    if (
      item.role === 'inline' &&
      (item.placementMarkerId === undefined || item.placementMarkerId.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Inline image "${item.id}" must reference a placementMarkerId.`,
      });
    }
    if (item.placementMarkerId !== undefined) {
      if (seenPlacementMarkers.has(item.placementMarkerId)) {
        duplicates.push(item.placementMarkerId);
      }
      seenPlacementMarkers.add(item.placementMarkerId);
    }
  }

  if (duplicates.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate placementMarkerId(s): ${duplicates.join(', ')}.`,
    });
  }
}

/**
 * Deterministic contract check: every inline image marker from the draft must
 * be covered by exactly one plan item's `placementMarkerId`, so the finished
 * article can place every image back where its marker was.
 *
 * @throws {ValidationError} When a marker is missing or covered more than once.
 */
export function assertMarkerCoverage(
  plan: ImagePlan,
  markers: readonly {
    readonly markerId: string;
    readonly role: 'hero' | 'inline';
    readonly descriptionHint: string;
  }[],
): void {
  const inlineMarkerIds = markers
    .filter((marker) => marker.role === 'inline')
    .map((marker) => marker.markerId);
  const coverage = new Map<string, number>();
  for (const item of plan.images) {
    if (item.placementMarkerId === undefined) {
      continue;
    }
    coverage.set(item.placementMarkerId, (coverage.get(item.placementMarkerId) ?? 0) + 1);
  }

  const missing = inlineMarkerIds.filter((markerId) => coverage.get(markerId) !== 1);
  if (missing.length > 0) {
    throw new ValidationError(IMAGE_PLANNER_MODULE_KEY, [
      `Plan must cover every inline image marker exactly once; missing or duplicated: ${missing.join(', ')}.`,
    ]);
  }
}

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: ModuleCostEventInput['outcome'],
): ModuleCostEventInput {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(IMAGE_PLANNER_MODULE_KEY, [
      `Provider returned unsupported cost provider "${response.providerName}".`,
    ]);
  }
  return {
    provider: response.providerName as ProviderName,
    modelId: response.modelId,
    promptVersion,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    cachedInputTokens: response.usage.cachedInputTokens,
    reasoningTokens: response.usage.reasoningTokens,
    estimatedCostUsd: response.costUsd,
    pricingVerifiedAt: response.pricingVerifiedAt,
    outcome,
    isImageGeneration: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    const frozenItems: unknown[] = value.map((item: unknown) => deepFreeze(item));
    return Object.freeze(frozenItems) as T;
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])),
    ) as T;
  }
  return value;
}
