/**
 * Provider-agnostic Humanizer module.
 *
 * The module refines an approved draft into a more natural, engaging,
 * human-quality article without inventing facts, changing technical meaning,
 * or modifying the approved article structure. Provider invocation, timing,
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
  DraftSectionSchema,
  PlanningSectionSchema,
  replaceDraft,
  ResearchSectionSchema,
  ReviewSectionSchema,
  SeoSectionSchema,
  type Draft,
  type DraftSection,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type ReviewOutput,
  type ReviewSection,
  type SeoSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const HUMANIZER_MODULE_KEY = 'humanizer' as const;
const MAX_OUTPUT_TOKENS = 8_000;
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

/**
 * Stable, persisted inputs available to the Humanizer through PipelineState.
 * The module requires research, planning, SEO, draft, and review sections
 * to understand the full context and constraints.
 */
export interface HumanizerRequest {
  readonly research: ResearchSection;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
  readonly draft: DraftSection;
  readonly review: ReviewSection;
}

export const HumanizerRequestSchema: z.ZodType<HumanizerRequest> = z
  .object({
    research: ResearchSectionSchema,
    planning: PlanningSectionSchema,
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
    review: ReviewSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract - Rich Humanizer Result
// ============================================================================

/** A score category with 0-100 range. */
export interface ScoreCategory {
  readonly score: number;
  readonly reasoning: string;
}

const ScoreCategorySchema: z.ZodType<ScoreCategory> = z
  .object({
    score: z.number().int().min(0).max(100),
    reasoning: z.string().trim().min(1),
  })
  .strict();

/** Statistics about improvements made during humanization. */
export interface ImprovementStatistics {
  readonly transitionsImproved: number;
  readonly hedgingPhrasesRemoved: number;
  readonly repetitiveStructuresFixed: number;
  readonly sentenceVarietyIncreased: number;
  readonly passiveToActive: number;
  readonly fillerWordsRemoved: number;
}

const ImprovementStatisticsSchema: z.ZodType<ImprovementStatistics> = z
  .object({
    transitionsImproved: z.number().int().min(0),
    hedgingPhrasesRemoved: z.number().int().min(0),
    repetitiveStructuresFixed: z.number().int().min(0),
    sentenceVarietyIncreased: z.number().int().min(0),
    passiveToActive: z.number().int().min(0),
    fillerWordsRemoved: z.number().int().min(0),
  })
  .strict();

/**
 * The complete immutable humanizer result exposed to downstream modules.
 * This is the rich output that gets projected into the minimal PipelineState Draft.
 */
export interface HumanizedResult {
  /** The humanized markdown content. */
  readonly markdown: string;
  /** Updated word count after humanization. */
  readonly wordCount: number;
  /** Preserved link markers from the original draft. */
  readonly linkMarkers: readonly {
    readonly markerId: string;
    readonly anchorTextHint: string;
  }[];
  /** Preserved image markers from the original draft. */
  readonly imageMarkers: readonly {
    readonly markerId: string;
    readonly role: 'hero' | 'inline';
    readonly descriptionHint: string;
  }[];
  /** Summary of humanization changes. */
  readonly humanizationSummary: string;
  /** Statistics about improvements made. */
  readonly improvementStatistics: ImprovementStatistics;
  /** Readability improvement score (0-100). */
  readonly readabilityImprovementScore: number;
  /** Fluency score (0-100). */
  readonly fluencyScore: number;
  /** Naturalness score (0-100). */
  readonly naturalnessScore: number;
  /** Style consistency score (0-100). */
  readonly styleConsistencyScore: number;
  /** Overall quality score derived from sub-scores. */
  readonly overallQualityScore: ScoreCategory;
}

const LinkMarkerSchema = z
  .object({
    markerId: z.string().trim().min(1),
    anchorTextHint: z.string().trim().min(1),
  })
  .strict();

const ImageMarkerSchema = z
  .object({
    markerId: z.string().trim().min(1),
    role: z.enum(['hero', 'inline']),
    descriptionHint: z.string().trim().min(1),
  })
  .strict();

export const HumanizedResultSchema: z.ZodType<HumanizedResult> = z
  .object({
    markdown: z.string().trim().min(1),
    wordCount: z.number().int().min(1),
    linkMarkers: z.array(LinkMarkerSchema),
    imageMarkers: z.array(ImageMarkerSchema).min(1),
    humanizationSummary: z.string().trim().min(1),
    improvementStatistics: ImprovementStatisticsSchema,
    readabilityImprovementScore: z.number().int().min(0).max(100),
    fluencyScore: z.number().int().min(0).max(100),
    naturalnessScore: z.number().int().min(0).max(100),
    styleConsistencyScore: z.number().int().min(0).max(100),
    overallQualityScore: ScoreCategorySchema,
  })
  .strict()
  .superRefine((result, context) => {
    // Verify exactly one hero image marker
    const heroMarkerCount = result.imageMarkers.filter((marker) => marker.role === 'hero').length;
    if (heroMarkerCount !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['imageMarkers'],
        message: 'Exactly one image marker must have role "hero".',
      });
    }

    // Verify marker IDs are unique
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

    // Verify marker IDs don't appear in markdown
    for (const markerId of markerIds) {
      if (result.markdown.includes(markerId)) {
        context.addIssue({
          code: 'custom',
          path: ['markdown'],
          message: `Marker id "${markerId}" must not appear in the visible markdown text.`,
        });
      }
    }

    // Verify link marker count matches [[link: occurrences
    if (countOccurrences(result.markdown, '[[link:') !== result.linkMarkers.length) {
      context.addIssue({
        code: 'custom',
        path: ['linkMarkers'],
        message: 'linkMarkers must have exactly one entry per "[[link: ...]]" marker in markdown.',
      });
    }

    // Verify image marker count matches [[image: occurrences
    if (countOccurrences(result.markdown, '[[image:') !== result.imageMarkers.length) {
      context.addIssue({
        code: 'custom',
        path: ['imageMarkers'],
        message:
          'imageMarkers must have exactly one entry per "[[image: ...]]" marker in markdown.',
      });
    }

    // Verify overall quality score is derived from sub-scores
    const expectedAverage = Math.round(
      (result.readabilityImprovementScore +
        result.fluencyScore +
        result.naturalnessScore +
        result.styleConsistencyScore) /
        4,
    );

    // Allow +/- 5 point tolerance
    if (Math.abs(result.overallQualityScore.score - expectedAverage) > 5) {
      context.addIssue({
        code: 'custom',
        path: ['overallQualityScore'],
        message: `overallQualityScore should be derived from sub-scores (expected ~${expectedAverage}, got ${result.overallQualityScore.score}).`,
      });
    }
  });

/** JSON-schema request supplied only when the selected provider supports it. */
export const HumanizedResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'markdown',
    'wordCount',
    'linkMarkers',
    'imageMarkers',
    'humanizationSummary',
    'improvementStatistics',
    'readabilityImprovementScore',
    'fluencyScore',
    'naturalnessScore',
    'styleConsistencyScore',
    'overallQualityScore',
  ],
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
    humanizationSummary: { type: 'string' },
    improvementStatistics: objectSchema(
      [
        'transitionsImproved',
        'hedgingPhrasesRemoved',
        'repetitiveStructuresFixed',
        'sentenceVarietyIncreased',
        'passiveToActive',
        'fillerWordsRemoved',
      ],
      {
        transitionsImproved: { type: 'integer' },
        hedgingPhrasesRemoved: { type: 'integer' },
        repetitiveStructuresFixed: { type: 'integer' },
        sentenceVarietyIncreased: { type: 'integer' },
        passiveToActive: { type: 'integer' },
        fillerWordsRemoved: { type: 'integer' },
      },
    ),
    readabilityImprovementScore: { type: 'integer', minimum: 0, maximum: 100 },
    fluencyScore: { type: 'integer', minimum: 0, maximum: 100 },
    naturalnessScore: { type: 'integer', minimum: 0, maximum: 100 },
    styleConsistencyScore: { type: 'integer', minimum: 0, maximum: 100 },
    overallQualityScore: objectSchema(['score', 'reasoning'], {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      reasoning: { type: 'string' },
    }),
  },
});

// ============================================================================
// Module Services Contract
// ============================================================================

/** Services injected by the composition root; no concrete provider leaks here. */
export interface HumanizerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const humanizerModuleMetadata: ModuleMetadata = Object.freeze({
  key: HUMANIZER_MODULE_KEY,
  displayName: 'Humanizer',
  description:
    'Refines an approved draft into a more natural, engaging, human-quality article without changing facts, structure, or SEO intent.',
  dependencies: Object.freeze([
    'research',
    'planner',
    'seo-planner',
    'writer',
    'reviewer-technical',
  ] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'research.structured-output',
      'planner.content-plan',
      'seo.strategy',
      'writer.draft',
      'reviewer.technical-review',
    ]),
    provides: Object.freeze(['humanizer.humanized-draft', 'humanizer.state-projection']),
  }),
});

// ============================================================================
// State Projection Functions
// ============================================================================

/** Builds a validated request from the module-owned PipelineState reads. */
export function buildHumanizerRequest(state: PipelineState): HumanizerRequest {
  if (state.research === undefined) {
    throw new ValidationError(HUMANIZER_MODULE_KEY, ['state.research is required.']);
  }
  if (state.planning === undefined) {
    throw new ValidationError(HUMANIZER_MODULE_KEY, ['state.planning is required.']);
  }
  if (state.seo === undefined) {
    throw new ValidationError(HUMANIZER_MODULE_KEY, ['state.seo is required.']);
  }
  if (state.draft === undefined) {
    throw new ValidationError(HUMANIZER_MODULE_KEY, ['state.draft is required.']);
  }
  if (state.review === undefined) {
    throw new ValidationError(HUMANIZER_MODULE_KEY, ['state.review is required.']);
  }

  return normalizeHumanizerRequest({
    research: assertValid(ResearchSectionSchema, state.research, HUMANIZER_MODULE_KEY),
    planning: assertValid(PlanningSectionSchema, state.planning, HUMANIZER_MODULE_KEY),
    seo: assertValid(SeoSectionSchema, state.seo, HUMANIZER_MODULE_KEY),
    draft: assertValid(DraftSectionSchema, state.draft, HUMANIZER_MODULE_KEY),
    review: assertValid(ReviewSectionSchema, state.review, HUMANIZER_MODULE_KEY),
  });
}

/** Validates and freezes the Humanizer module input contract. */
export function normalizeHumanizerRequest(request: HumanizerRequest): HumanizerRequest {
  const parsed = assertValid(HumanizerRequestSchema, request, HUMANIZER_MODULE_KEY);
  return deepFreeze({
    research: parsed.research,
    planning: parsed.planning,
    seo: parsed.seo,
    draft: parsed.draft,
    review: parsed.review,
  });
}

/**
 * Projects the rich humanizer result into the minimal PipelineState Draft contract.
 * This maintains backward compatibility with the existing state model.
 */
export function toDraft(result: HumanizedResult): Draft {
  const validated = assertValid(HumanizedResultSchema, result, HUMANIZER_MODULE_KEY);
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
    HUMANIZER_MODULE_KEY,
  );
}

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Humanizer module. */
export function createHumanizerModule(): PipelineModule<
  HumanizerRequest,
  HumanizedResult,
  HumanizerModuleServices
> {
  return defineModule({
    metadata: humanizerModuleMetadata,
    execute: executeHumanizer,
  });
}

/** Registers one Humanizer module without triggering execution. */
export function registerHumanizerModule(
  registry: ModuleRegistry<HumanizerModuleServices>,
  module: PipelineModule<
    HumanizerRequest,
    HumanizedResult,
    HumanizerModuleServices
  > = createHumanizerModule(),
): ModuleRegistry<HumanizerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Humanizer module. */
export function createHumanizerModuleBinding(): OrchestratorModuleBinding<HumanizerModuleServices> {
  return Object.freeze({
    key: HUMANIZER_MODULE_KEY,
    createInput: (state: PipelineState): HumanizerRequest => buildHumanizerRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState =>
      replaceDraft(
        state,
        HUMANIZER_MODULE_KEY,
        toDraft(assertValid(HumanizedResultSchema, output, HUMANIZER_MODULE_KEY)),
      ),
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

async function executeHumanizer(
  input: HumanizerRequest,
  context: ModuleExecutionContext<HumanizerModuleServices>,
): Promise<HumanizedResult> {
  const request = normalizeHumanizerRequest(input);

  // Build the prompt with all necessary context
  const prompt = await context.services.promptRegistry.get('humanizer', {
    draftMarkdown: request.draft.current.markdown,
    wordCount: String(request.draft.current.wordCount),
    technicalIssuesAsMarkdownList: formatReviewIssues(request.review.technical),
    seoIssuesAsMarkdownList: formatReviewIssues(request.review.seo),
    focusKeyword: request.seo.focusKeyword,
    targetWordCount: String(request.planning.targetWordCount),
  });

  // Call the LLM provider
  const response = await context.services.llmProvider.complete({
    moduleKey: HUMANIZER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: HumanizedResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, HumanizedResultSchema, HUMANIZER_MODULE_KEY),
    );
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return result;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

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

function formatReviewIssues(review: ReviewOutput | undefined): string {
  if (review === undefined || review.issues.length === 0) {
    return '- None identified';
  }

  return review.issues
    .map(
      (issue) =>
        `- [${issue.severity.toUpperCase()}] ${issue.location}: ${issue.description}${issue.suggestedFix ? ` (Suggested: ${issue.suggestedFix})` : ''}`,
    )
    .join('\n');
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
    throw new ValidationError(HUMANIZER_MODULE_KEY, [
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
