/**
 * Provider-agnostic Draft Writer module.
 *
 * The module turns the persisted research, content plan, and SEO strategy
 * into one immutable first-draft article. Provider invocation, timing,
 * cost-event persistence, scheduling, and checkpointing remain owned by
 * ModuleRunner and PipelineOrchestrator.
 */

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
  DraftSchema,
  PlanningSectionSchema,
  replaceDraft,
  ResearchSectionSchema,
  SeoSectionSchema,
  type Draft,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type SeoSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const DRAFT_WRITER_MODULE_KEY = 'writer' as const;
const MAX_OUTPUT_TOKENS = 6_000;
const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** Stable, persisted inputs available to the Draft Writer through PipelineState. */
export interface WriterRequest {
  readonly research: ResearchSection;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
}

/** An internal-link placement marker inside the drafted Markdown. */
export interface LinkMarker {
  readonly markerId: string;
  readonly anchorTextHint: string;
}

/** An image placement marker inside the drafted Markdown. */
export interface ImageMarker {
  readonly markerId: string;
  readonly role: 'hero' | 'inline';
  readonly descriptionHint: string;
}

/**
 * The complete immutable first draft exposed to downstream modules. The
 * frozen PipelineState projection intentionally retains only the pre-existing
 * Draft fields so this module does not expand the frozen state contract.
 */
export interface WriterResult {
  readonly markdown: string;
  readonly wordCount: number;
  readonly linkMarkers: readonly LinkMarker[];
  readonly imageMarkers: readonly ImageMarker[];
}

/** Services injected by the composition root; no concrete provider leaks here. */
export interface DraftWriterModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

export const WriterRequestSchema: z.ZodType<WriterRequest> = z
  .object({
    research: ResearchSectionSchema,
    planning: PlanningSectionSchema,
    seo: SeoSectionSchema,
  })
  .strict();

const LinkMarkerSchema: z.ZodType<LinkMarker> = z
  .object({
    markerId: z.string().trim().min(1),
    anchorTextHint: z.string().trim().min(1),
  })
  .strict();

const ImageMarkerSchema: z.ZodType<ImageMarker> = z
  .object({
    markerId: z.string().trim().min(1),
    role: z.enum(['hero', 'inline']),
    descriptionHint: z.string().trim().min(1),
  })
  .strict();

/** Runtime contract for every structured provider response. */
export const WriterResultSchema: z.ZodType<WriterResult> = z
  .object({
    markdown: z.string().trim().min(1),
    wordCount: z.number().int().min(1),
    linkMarkers: z.array(LinkMarkerSchema),
    imageMarkers: z.array(ImageMarkerSchema).min(1),
  })
  .strict()
  .superRefine((result, context) => {
    const heroMarkerCount = result.imageMarkers.filter((marker) => marker.role === 'hero').length;
    if (heroMarkerCount !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['imageMarkers'],
        message: 'Exactly one image marker must have role "hero".',
      });
    }

    const markerIds = [
      ...result.linkMarkers.map((marker) => marker.markerId),
      ...result.imageMarkers.map((marker) => marker.markerId),
    ];
    if (new Set(markerIds).size !== markerIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['linkMarkers'],
        message: 'Marker IDs must be unique across linkMarkers and imageMarkers.',
      });
    }

    for (const markerId of markerIds) {
      if (result.markdown.includes(markerId)) {
        context.addIssue({
          code: 'custom',
          path: ['markdown'],
          message: `Marker id "${markerId}" must not appear in the visible markdown text.`,
        });
      }
    }

    if (countOccurrences(result.markdown, '[[link:') !== result.linkMarkers.length) {
      context.addIssue({
        code: 'custom',
        path: ['linkMarkers'],
        message: 'linkMarkers must have exactly one entry per "[[link: ...]]" marker in markdown.',
      });
    }

    if (countOccurrences(result.markdown, '[[image:') !== result.imageMarkers.length) {
      context.addIssue({
        code: 'custom',
        path: ['imageMarkers'],
        message:
          'imageMarkers must have exactly one entry per "[[image: ...]]" marker in markdown.',
      });
    }
  });

/** JSON-schema request supplied only when the selected provider supports it. */
export const WriterResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['markdown', 'wordCount', 'linkMarkers', 'imageMarkers'],
  properties: {
    markdown: { type: 'string' },
    wordCount: { type: 'integer' },
    linkMarkers: {
      type: 'array',
      items: objectSchema(['markerId', 'anchorTextHint'], {
        markerId: { type: 'string' },
        anchorTextHint: { type: 'string' },
      }),
    },
    imageMarkers: {
      type: 'array',
      items: objectSchema(['markerId', 'role', 'descriptionHint'], {
        markerId: { type: 'string' },
        role: { type: 'string', enum: ['hero', 'inline'] },
        descriptionHint: { type: 'string' },
      }),
    },
  },
});

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const draftWriterModuleMetadata: ModuleMetadata = Object.freeze({
  key: DRAFT_WRITER_MODULE_KEY,
  displayName: 'Draft Writer',
  description:
    'Transforms persisted research, content planning, and SEO strategy into the first complete article draft.',
  dependencies: Object.freeze(['research', 'planner', 'seo-planner'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'research.structured-output',
      'planner.content-plan',
      'seo.strategy',
    ]),
    provides: Object.freeze(['writer.draft', 'writer.state-projection']),
  }),
});

/** Builds a validated request from the module-owned PipelineState reads. */
export function buildWriterRequest(state: PipelineState): WriterRequest {
  if (state.research === undefined) {
    throw new ValidationError(DRAFT_WRITER_MODULE_KEY, ['state.research is required.']);
  }
  if (state.planning === undefined) {
    throw new ValidationError(DRAFT_WRITER_MODULE_KEY, ['state.planning is required.']);
  }
  if (state.seo === undefined) {
    throw new ValidationError(DRAFT_WRITER_MODULE_KEY, ['state.seo is required.']);
  }

  return normalizeWriterRequest({
    research: assertValid(ResearchSectionSchema, state.research, DRAFT_WRITER_MODULE_KEY),
    planning: assertValid(PlanningSectionSchema, state.planning, DRAFT_WRITER_MODULE_KEY),
    seo: assertValid(SeoSectionSchema, state.seo, DRAFT_WRITER_MODULE_KEY),
  });
}

/** Validates and freezes the Draft Writer module input contract. */
export function normalizeWriterRequest(request: WriterRequest): WriterRequest {
  const parsed = assertValid(WriterRequestSchema, request, DRAFT_WRITER_MODULE_KEY);
  return deepFreeze({
    research: parsed.research,
    planning: parsed.planning,
    seo: parsed.seo,
  });
}

/** Projects the rich draft result into the frozen, minimal PipelineState Draft contract. */
export function toDraft(result: WriterResult): Draft {
  const validated = assertValid(WriterResultSchema, result, DRAFT_WRITER_MODULE_KEY);
  return assertValid(
    DraftSchema,
    deepFreeze({
      markdown: validated.markdown,
      wordCount: validated.wordCount,
      linkMarkers: validated.linkMarkers.map((marker) => ({
        markerId: marker.markerId,
        anchorTextHint: marker.anchorTextHint,
      })),
      imageMarkers: validated.imageMarkers.map((marker) => ({
        markerId: marker.markerId,
        role: marker.role,
        descriptionHint: marker.descriptionHint,
      })),
    }),
    DRAFT_WRITER_MODULE_KEY,
  );
}

/** Creates an independently testable, registry-discoverable Draft Writer module. */
export function createDraftWriterModule(): PipelineModule<
  WriterRequest,
  WriterResult,
  DraftWriterModuleServices
> {
  return defineModule({
    metadata: draftWriterModuleMetadata,
    execute: executeDraftWriter,
  });
}

/** Registers one Draft Writer module without triggering execution. */
export function registerDraftWriterModule(
  registry: ModuleRegistry<DraftWriterModuleServices>,
  module: PipelineModule<
    WriterRequest,
    WriterResult,
    DraftWriterModuleServices
  > = createDraftWriterModule(),
): ModuleRegistry<DraftWriterModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Draft Writer module. */
export function createDraftWriterModuleBinding(): OrchestratorModuleBinding<DraftWriterModuleServices> {
  return Object.freeze({
    key: DRAFT_WRITER_MODULE_KEY,
    createInput: (state: PipelineState): WriterRequest => buildWriterRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState =>
      replaceDraft(
        state,
        DRAFT_WRITER_MODULE_KEY,
        toDraft(assertValid(WriterResultSchema, output, DRAFT_WRITER_MODULE_KEY)),
      ),
  });
}

async function executeDraftWriter(
  input: WriterRequest,
  context: ModuleExecutionContext<DraftWriterModuleServices>,
): Promise<WriterResult> {
  const request = normalizeWriterRequest(input);
  const prompt = await context.services.promptRegistry.get('writer', {
    angle: request.planning.angle,
    targetWordCount: String(request.planning.targetWordCount),
    outlineAsMarkdownList: formatOutlineAsMarkdownList(request.planning),
    keyFactsAsMarkdownList: formatMarkdownList(request.research.keyFacts),
    focusKeyword: request.seo.focusKeyword,
  });
  const response = await context.services.llmProvider.complete({
    moduleKey: DRAFT_WRITER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: WriterResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, WriterResultSchema, DRAFT_WRITER_MODULE_KEY),
    );
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return result;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze([...required]),
    properties: Object.freeze({ ...properties }),
  });
}

function formatMarkdownList(values: readonly string[]): string {
  return values.length === 0 ? '- None provided' : values.map((value) => `- ${value}`).join('\n');
}

function formatOutlineAsMarkdownList(planning: PlanningSection): string {
  return planning.outline
    .map(
      (item) =>
        `${'#'.repeat(item.level)} ${item.heading}\n${formatMarkdownList(item.talkingPoints)}`,
    )
    .join('\n\n');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
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

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: 'success' | 'validationError',
) {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(DRAFT_WRITER_MODULE_KEY, [
      `Provider returned unsupported cost provider "${response.providerName}".`,
    ]);
  }

  return Object.freeze({
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
  });
}
