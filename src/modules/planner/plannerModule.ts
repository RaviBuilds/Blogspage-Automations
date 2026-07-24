/**
 * Provider-agnostic Content Planner module.
 *
 * The module converts a validated brief and structured research result into one
 * immutable content plan. Provider invocation, timing, cost-event persistence,
 * scheduling, and checkpointing remain owned by ModuleRunner and
 * PipelineOrchestrator.
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
  BriefSchema,
  PlanningSectionSchema,
  ResearchSectionSchema,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const PLANNER_MODULE_KEY = 'planner' as const;
const DEFAULT_TARGET_AUDIENCE = 'General audience';
const MAX_OUTPUT_TOKENS = 2_400;
const PROVIDER_NAMES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** The normalized, provider-independent input required to produce a content plan. */
export interface PlannerRequest {
  readonly topic: string;
  readonly targetAudience: string;
  readonly keywordHints: readonly string[];
  readonly constraints: readonly string[];
  readonly research: ResearchSection;
}

/** One ordered outline item with a concrete content objective. */
export interface PlannerOutlineItem {
  readonly heading: string;
  readonly level: 1 | 2 | 3;
  readonly sectionGoal: string;
  readonly talkingPoints: readonly string[];
}

/** A suggested internal destination and the role it should serve. */
export interface InternalLinkOpportunity {
  readonly anchorText: string;
  readonly targetTopic: string;
  readonly rationale: string;
}

/** A credible external source type or publication to consult while drafting. */
export interface ExternalReferenceSuggestion {
  readonly title: string;
  readonly source: string;
  readonly rationale: string;
  readonly url?: string | undefined;
}

/** A candidate FAQ with a draft answer direction. */
export interface FaqCandidate {
  readonly question: string;
  readonly answerDirection: string;
}

/**
 * The complete immutable content plan exposed to downstream consumers. The
 * frozen PipelineState projection intentionally retains only its existing
 * PlanningSection fields so Phase 7B does not expand the frozen state contract.
 */
export interface PlannerResult {
  readonly titleCandidates: readonly string[];
  readonly recommendedTitle: string;
  readonly metaTitle: string;
  readonly metaDescriptionDraft: string;
  readonly articleGoal: string;
  readonly readerPersona: string;
  readonly searchIntent: string;
  readonly primaryKeyword: string;
  readonly secondaryKeywords: readonly string[];
  readonly suggestedUrlSlug: string;
  readonly recommendedArticleLength: number;
  readonly readingLevel: string;
  readonly toneOfVoice: string;
  readonly articleStructure: string;
  readonly outline: readonly PlannerOutlineItem[];
  readonly internalLinkingOpportunities: readonly InternalLinkOpportunity[];
  readonly externalReferenceSuggestions: readonly ExternalReferenceSuggestion[];
  readonly faqCandidates: readonly FaqCandidate[];
  readonly ctaRecommendation: string;
  readonly authorNotes: readonly string[];
  readonly contentConstraints: readonly string[];
  readonly angle: string;
}

/** Services injected by the composition root; no concrete provider leaks here. */
export interface PlannerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

export const PlannerRequestSchema: z.ZodType<PlannerRequest> = z
  .object({
    topic: z.string().trim().min(1),
    targetAudience: z.string().trim().min(1),
    keywordHints: z.array(z.string().trim().min(1)),
    constraints: z.array(z.string().trim().min(1)),
    research: ResearchSectionSchema,
  })
  .strict();

const PlannerOutlineItemSchema: z.ZodType<PlannerOutlineItem> = z
  .object({
    heading: z.string().trim().min(1),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    sectionGoal: z.string().trim().min(1),
    talkingPoints: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const InternalLinkOpportunitySchema: z.ZodType<InternalLinkOpportunity> = z
  .object({
    anchorText: z.string().trim().min(1),
    targetTopic: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
  })
  .strict();

const ExternalReferenceSuggestionSchema: z.ZodType<ExternalReferenceSuggestion> = z
  .object({
    title: z.string().trim().min(1),
    source: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    url: z.string().url().optional(),
  })
  .strict();

const FaqCandidateSchema: z.ZodType<FaqCandidate> = z
  .object({
    question: z.string().trim().min(1),
    answerDirection: z.string().trim().min(1),
  })
  .strict();

/** Runtime contract for every structured provider response. */
export const PlannerResultSchema: z.ZodType<PlannerResult> = z
  .object({
    titleCandidates: z.array(z.string().trim().min(1)).min(3),
    recommendedTitle: z.string().trim().min(1),
    metaTitle: z.string().trim().min(1),
    metaDescriptionDraft: z.string().trim().min(1),
    articleGoal: z.string().trim().min(1),
    readerPersona: z.string().trim().min(1),
    searchIntent: z.string().trim().min(1),
    primaryKeyword: z.string().trim().min(1),
    secondaryKeywords: z.array(z.string().trim().min(1)),
    suggestedUrlSlug: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    recommendedArticleLength: z.number().int().min(800).max(3_000),
    readingLevel: z.string().trim().min(1),
    toneOfVoice: z.string().trim().min(1),
    articleStructure: z.string().trim().min(1),
    outline: z.array(PlannerOutlineItemSchema).min(3),
    internalLinkingOpportunities: z.array(InternalLinkOpportunitySchema),
    externalReferenceSuggestions: z.array(ExternalReferenceSuggestionSchema),
    faqCandidates: z.array(FaqCandidateSchema),
    ctaRecommendation: z.string().trim().min(1),
    authorNotes: z.array(z.string().trim().min(1)),
    contentConstraints: z.array(z.string().trim().min(1)),
    angle: z.string().trim().min(1),
  })
  .strict()
  .superRefine((result, context) => {
    if (new Set(result.titleCandidates).size !== result.titleCandidates.length) {
      context.addIssue({
        code: 'custom',
        path: ['titleCandidates'],
        message: 'Title candidates must be distinct.',
      });
    }

    if (!result.titleCandidates.includes(result.recommendedTitle)) {
      context.addIssue({
        code: 'custom',
        path: ['recommendedTitle'],
        message: 'Recommended title must be one of the title candidates.',
      });
    }

    if (result.outline.filter((item) => item.level === 2).length < 3) {
      context.addIssue({
        code: 'custom',
        path: ['outline'],
        message: 'Outline must contain at least three level-2 sections.',
      });
    }

    if (result.outline[0]?.level !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['outline', 0, 'level'],
        message: 'Outline must start with a level-1 heading.',
      });
    }
  });

/** JSON-schema request supplied only when the selected provider supports it. */
export const PlannerResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'titleCandidates',
    'recommendedTitle',
    'metaTitle',
    'metaDescriptionDraft',
    'articleGoal',
    'readerPersona',
    'searchIntent',
    'primaryKeyword',
    'secondaryKeywords',
    'suggestedUrlSlug',
    'recommendedArticleLength',
    'readingLevel',
    'toneOfVoice',
    'articleStructure',
    'outline',
    'internalLinkingOpportunities',
    'externalReferenceSuggestions',
    'faqCandidates',
    'ctaRecommendation',
    'authorNotes',
    'contentConstraints',
    'angle',
  ],
  properties: {
    titleCandidates: { type: 'array', items: { type: 'string' } },
    recommendedTitle: { type: 'string' },
    metaTitle: { type: 'string' },
    metaDescriptionDraft: { type: 'string' },
    articleGoal: { type: 'string' },
    readerPersona: { type: 'string' },
    searchIntent: { type: 'string' },
    primaryKeyword: { type: 'string' },
    secondaryKeywords: { type: 'array', items: { type: 'string' } },
    suggestedUrlSlug: { type: 'string' },
    recommendedArticleLength: { type: 'integer' },
    readingLevel: { type: 'string' },
    toneOfVoice: { type: 'string' },
    articleStructure: { type: 'string' },
    outline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'level', 'sectionGoal', 'talkingPoints'],
        properties: {
          heading: { type: 'string' },
          level: { type: 'integer', enum: [1, 2, 3] },
          sectionGoal: { type: 'string' },
          talkingPoints: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    internalLinkingOpportunities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['anchorText', 'targetTopic', 'rationale'],
        properties: {
          anchorText: { type: 'string' },
          targetTopic: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
    externalReferenceSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'source', 'rationale'],
        properties: {
          title: { type: 'string' },
          source: { type: 'string' },
          rationale: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    faqCandidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answerDirection'],
        properties: {
          question: { type: 'string' },
          answerDirection: { type: 'string' },
        },
      },
    },
    ctaRecommendation: { type: 'string' },
    authorNotes: { type: 'array', items: { type: 'string' } },
    contentConstraints: { type: 'array', items: { type: 'string' } },
    angle: { type: 'string' },
  },
});

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const plannerModuleMetadata: ModuleMetadata = Object.freeze({
  key: PLANNER_MODULE_KEY,
  displayName: 'Content Planner',
  description: 'Transforms structured research into an immutable, actionable content plan.',
  dependencies: Object.freeze(['sheet-reader', 'research'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze(['llm.complete', 'prompt-registry.get', 'research.structured-output']),
    provides: Object.freeze(['planner.content-plan', 'planner.state-projection']),
  }),
});

/** Builds a validated planner request from the module-owned PipelineState reads. */
export function buildPlannerRequest(state: PipelineState): PlannerRequest {
  if (state.brief === undefined) {
    throw new ValidationError(PLANNER_MODULE_KEY, ['state.brief is required.']);
  }
  if (state.research === undefined) {
    throw new ValidationError(PLANNER_MODULE_KEY, ['state.research is required.']);
  }

  const brief = assertValid(BriefSchema, state.brief, PLANNER_MODULE_KEY);
  const research = assertValid(ResearchSectionSchema, state.research, PLANNER_MODULE_KEY);

  return normalizePlannerRequest({
    topic: brief.topic,
    targetAudience: brief.targetAudience ?? DEFAULT_TARGET_AUDIENCE,
    keywordHints: normalizeStrings(brief.keywordHints),
    constraints: normalizeStrings(brief.constraints),
    research,
  });
}

/** Validates, normalizes, deduplicates, and freezes a module input contract. */
export function normalizePlannerRequest(request: PlannerRequest): PlannerRequest {
  const parsed = assertValid(PlannerRequestSchema, request, PLANNER_MODULE_KEY);
  return Object.freeze({
    topic: parsed.topic,
    targetAudience: parsed.targetAudience,
    keywordHints: freezeStrings(parsed.keywordHints),
    constraints: freezeStrings(parsed.constraints),
    research: freezeResearchSection(parsed.research),
  });
}

/** Projects the rich public result into the frozen PipelineState planning shape. */
export function toPlanningSection(result: PlannerResult): PlanningSection {
  const validated = assertValid(PlannerResultSchema, result, PLANNER_MODULE_KEY);
  return assertValid(
    PlanningSectionSchema,
    Object.freeze({
      titleCandidates: freezeStrings(validated.titleCandidates),
      outline: Object.freeze(
        validated.outline
          .filter((item) => item.level !== 1)
          .map((item) =>
            Object.freeze({
              heading: item.heading,
              level: item.level,
              talkingPoints: freezeStrings(item.talkingPoints),
            }),
          ),
      ),
      targetWordCount: validated.recommendedArticleLength,
      angle: validated.angle,
    }),
    PLANNER_MODULE_KEY,
  );
}

/** Creates an independently testable, registry-discoverable Content Planner module. */
export function createPlannerModule(): PipelineModule<
  PlannerRequest,
  PlannerResult,
  PlannerModuleServices
> {
  return defineModule({
    metadata: plannerModuleMetadata,
    execute: executePlanner,
  });
}

/** Registers one Content Planner module without triggering execution. */
export function registerPlannerModule(
  registry: ModuleRegistry<PlannerModuleServices>,
  module: PipelineModule<
    PlannerRequest,
    PlannerResult,
    PlannerModuleServices
  > = createPlannerModule(),
): ModuleRegistry<PlannerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the planner module. */
export function createPlannerModuleBinding(): OrchestratorModuleBinding<PlannerModuleServices> {
  return Object.freeze({
    key: PLANNER_MODULE_KEY,
    createInput: (state: PipelineState): PlannerRequest => buildPlannerRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => ({
      ...state,
      planning: toPlanningSection(assertValid(PlannerResultSchema, output, PLANNER_MODULE_KEY)),
    }),
  });
}

async function executePlanner(
  input: PlannerRequest,
  context: ModuleExecutionContext<PlannerModuleServices>,
): Promise<PlannerResult> {
  const request = normalizePlannerRequest(input);
  const prompt = await context.services.promptRegistry.get('planner', {
    topic: request.topic,
    targetAudience: request.targetAudience,
    suggestedAngle: request.research.suggestedAngle,
    keyFactsAsMarkdownList: formatMarkdownList(request.research.keyFacts),
  });
  const response = await context.services.llmProvider.complete({
    moduleKey: PLANNER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: PlannerResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const parsed = parseJsonWithSchema(response.text, PlannerResultSchema, PLANNER_MODULE_KEY);
    const result = freezePlannerResult({
      ...parsed,
      contentConstraints: mergeConstraints(parsed.contentConstraints, request.constraints),
    });
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return result;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

function normalizeStrings(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze([
    ...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)),
  ]);
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function mergeConstraints(
  generatedConstraints: readonly string[],
  requestConstraints: readonly string[],
): readonly string[] {
  return freezeStrings([...generatedConstraints, ...requestConstraints]);
}

function formatMarkdownList(values: readonly string[]): string {
  return values.length === 0
    ? '- No research facts provided'
    : values.map((value) => `- ${value}`).join('\n');
}

function freezeResearchSection(research: ResearchSection): ResearchSection {
  return Object.freeze({
    keyFacts: freezeStrings(research.keyFacts),
    suggestedAngle: research.suggestedAngle,
    ...(research.competitorGapNotes === undefined
      ? {}
      : { competitorGapNotes: freezeStrings(research.competitorGapNotes) }),
    candidateStatistics: Object.freeze(
      research.candidateStatistics.map((statistic) =>
        Object.freeze({
          claim: statistic.claim,
          ...(statistic.informalSource === undefined
            ? {}
            : { informalSource: statistic.informalSource }),
        }),
      ),
    ),
  });
}

function freezePlannerResult(result: PlannerResult): PlannerResult {
  return Object.freeze({
    titleCandidates: freezeStrings(result.titleCandidates),
    recommendedTitle: result.recommendedTitle,
    metaTitle: result.metaTitle,
    metaDescriptionDraft: result.metaDescriptionDraft,
    articleGoal: result.articleGoal,
    readerPersona: result.readerPersona,
    searchIntent: result.searchIntent,
    primaryKeyword: result.primaryKeyword,
    secondaryKeywords: freezeStrings(result.secondaryKeywords),
    suggestedUrlSlug: result.suggestedUrlSlug,
    recommendedArticleLength: result.recommendedArticleLength,
    readingLevel: result.readingLevel,
    toneOfVoice: result.toneOfVoice,
    articleStructure: result.articleStructure,
    outline: Object.freeze(
      result.outline.map((item) =>
        Object.freeze({
          heading: item.heading,
          level: item.level,
          sectionGoal: item.sectionGoal,
          talkingPoints: freezeStrings(item.talkingPoints),
        }),
      ),
    ),
    internalLinkingOpportunities: Object.freeze(
      result.internalLinkingOpportunities.map((item) =>
        Object.freeze({
          anchorText: item.anchorText,
          targetTopic: item.targetTopic,
          rationale: item.rationale,
        }),
      ),
    ),
    externalReferenceSuggestions: Object.freeze(
      result.externalReferenceSuggestions.map((item) =>
        Object.freeze({
          title: item.title,
          source: item.source,
          rationale: item.rationale,
          ...(item.url === undefined ? {} : { url: item.url }),
        }),
      ),
    ),
    faqCandidates: Object.freeze(
      result.faqCandidates.map((item) =>
        Object.freeze({ question: item.question, answerDirection: item.answerDirection }),
      ),
    ),
    ctaRecommendation: result.ctaRecommendation,
    authorNotes: freezeStrings(result.authorNotes),
    contentConstraints: freezeStrings(result.contentConstraints),
    angle: result.angle,
  });
}

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: 'success' | 'validationError',
) {
  if (!PROVIDER_NAMES.has(response.providerName)) {
    throw new ValidationError(PLANNER_MODULE_KEY, [
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
