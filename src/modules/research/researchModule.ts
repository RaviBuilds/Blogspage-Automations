/**
 * Provider-agnostic research module.
 *
 * The module converts a pipeline brief into one normalized research request,
 * resolves the registered prompt, and delegates one structured completion to
 * the injected LLMProvider. Pipeline scheduling, persistence, timing, and
 * cost-event ownership remain with ModuleRunner and PipelineOrchestrator.
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
import { BriefSchema, type PipelineState, type ResearchSection } from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const RESEARCH_MODULE_KEY = 'research' as const;
const DEFAULT_TARGET_AUDIENCE = 'General audience';
const MAX_OUTPUT_TOKENS = 1_800;
const PROVIDER_NAMES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** The normalized, provider-independent input required to research one brief. */
export interface ResearchRequest {
  readonly topic: string;
  readonly targetAudience: string;
  readonly keywordHints: readonly string[];
  readonly constraints: readonly string[];
}

/** A concrete observation about a competing article or content pattern. */
export interface CompetitorObservation {
  readonly competitor: string;
  readonly observation: string;
}

/** A non-fabricated reference that supports a research finding. */
export interface ResearchReference {
  readonly title: string;
  readonly source: string;
  readonly url?: string | undefined;
}

/** A candidate statistic retained for the legacy PipelineState projection. */
export interface CandidateStatistic {
  readonly claim: string;
  readonly informalSource?: string | undefined;
}

/**
 * The complete immutable research output made available to downstream module
 * bindings. `toResearchSection` projects this richer contract to the frozen
 * PipelineState research section without coupling later modules to providers.
 */
export interface ResearchResult {
  readonly topic: string;
  readonly targetAudience: string;
  readonly searchIntent: string;
  readonly primaryKeywords: readonly string[];
  readonly secondaryKeywords: readonly string[];
  readonly competitorObservations: readonly CompetitorObservation[];
  readonly questionsUsersAsk: readonly string[];
  readonly keyInsights: readonly string[];
  readonly references: readonly ResearchReference[];
  readonly confidenceScore?: number | undefined;
  readonly suggestedAngle: string;
  readonly candidateStatistics: readonly CandidateStatistic[];
}

/** Services injected by the composition root; no concrete adapter leaks here. */
export interface ResearchModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

export const ResearchRequestSchema: z.ZodType<ResearchRequest> = z
  .object({
    topic: z.string().trim().min(1),
    targetAudience: z.string().trim().min(1),
    keywordHints: z.array(z.string().trim().min(1)),
    constraints: z.array(z.string().trim().min(1)),
  })
  .strict();

const CompetitorObservationSchema: z.ZodType<CompetitorObservation> = z
  .object({
    competitor: z.string().trim().min(1),
    observation: z.string().trim().min(1),
  })
  .strict();

const ResearchReferenceSchema: z.ZodType<ResearchReference> = z
  .object({
    title: z.string().trim().min(1),
    source: z.string().trim().min(1),
    url: z.string().url().optional(),
  })
  .strict();

const CandidateStatisticSchema: z.ZodType<CandidateStatistic> = z
  .object({
    claim: z.string().trim().min(1),
    informalSource: z.string().trim().min(1).optional(),
  })
  .strict();

/** Runtime contract for every structured provider response. */
export const ResearchResultSchema: z.ZodType<ResearchResult> = z
  .object({
    topic: z.string().trim().min(1),
    targetAudience: z.string().trim().min(1),
    searchIntent: z.string().trim().min(1),
    primaryKeywords: z.array(z.string().trim().min(1)).min(1),
    secondaryKeywords: z.array(z.string().trim().min(1)),
    competitorObservations: z.array(CompetitorObservationSchema),
    questionsUsersAsk: z.array(z.string().trim().min(1)),
    keyInsights: z.array(z.string().trim().min(1)).min(3),
    references: z.array(ResearchReferenceSchema),
    confidenceScore: z.number().min(0).max(1).optional(),
    suggestedAngle: z.string().trim().min(1),
    candidateStatistics: z.array(CandidateStatisticSchema),
  })
  .strict();

/** JSON-schema request supplied only when the selected provider supports it. */
export const ResearchResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'topic',
    'targetAudience',
    'searchIntent',
    'primaryKeywords',
    'secondaryKeywords',
    'competitorObservations',
    'questionsUsersAsk',
    'keyInsights',
    'references',
    'suggestedAngle',
    'candidateStatistics',
  ],
  properties: {
    topic: { type: 'string' },
    targetAudience: { type: 'string' },
    searchIntent: { type: 'string' },
    primaryKeywords: { type: 'array', items: { type: 'string' } },
    secondaryKeywords: { type: 'array', items: { type: 'string' } },
    competitorObservations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['competitor', 'observation'],
        properties: {
          competitor: { type: 'string' },
          observation: { type: 'string' },
        },
      },
    },
    questionsUsersAsk: { type: 'array', items: { type: 'string' } },
    keyInsights: { type: 'array', items: { type: 'string' } },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'source'],
        properties: {
          title: { type: 'string' },
          source: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
    confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
    suggestedAngle: { type: 'string' },
    candidateStatistics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim'],
        properties: {
          claim: { type: 'string' },
          informalSource: { type: 'string' },
        },
      },
    },
  },
});

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const researchModuleMetadata: ModuleMetadata = Object.freeze({
  key: RESEARCH_MODULE_KEY,
  displayName: 'Research',
  description: 'Builds structured factual grounding from a normalized content brief.',
  dependencies: Object.freeze(['sheet-reader'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze(['llm.complete', 'prompt-registry.get']),
    provides: Object.freeze(['research.structured-output', 'research.state-projection']),
  }),
});

/**
 * Converts PipelineState.brief to the stable input contract consumed by this
 * module. Missing input is a typed validation failure rather than a provider
 * call, preserving deterministic fail-fast behavior.
 */
export function buildResearchRequest(state: PipelineState): ResearchRequest {
  if (state.brief === undefined) {
    throw new ValidationError(RESEARCH_MODULE_KEY, ['state.brief is required.']);
  }

  const brief = assertValid(BriefSchema, state.brief, RESEARCH_MODULE_KEY);
  return normalizeResearchRequest({
    topic: brief.topic,
    targetAudience: brief.targetAudience ?? DEFAULT_TARGET_AUDIENCE,
    keywordHints: normalizeStrings(brief.keywordHints),
    constraints: normalizeStrings(brief.constraints),
  });
}

/** Validates, normalizes, deduplicates, and freezes a module input contract. */
export function normalizeResearchRequest(request: ResearchRequest): ResearchRequest {
  const parsed = assertValid(ResearchRequestSchema, request, RESEARCH_MODULE_KEY);
  return Object.freeze({
    topic: parsed.topic,
    targetAudience: parsed.targetAudience,
    keywordHints: freezeStrings(parsed.keywordHints),
    constraints: freezeStrings(parsed.constraints),
  });
}

/** Projects the rich public result into the frozen PipelineState research shape. */
export function toResearchSection(result: ResearchResult): ResearchSection {
  const validated = assertValid(ResearchResultSchema, result, RESEARCH_MODULE_KEY);
  const competitorGapNotes = validated.competitorObservations.map(
    (item) => `${item.competitor}: ${item.observation}`,
  );

  return Object.freeze({
    keyFacts: freezeStrings(validated.keyInsights),
    suggestedAngle: validated.suggestedAngle,
    ...(competitorGapNotes.length > 0
      ? { competitorGapNotes: freezeStrings(competitorGapNotes) }
      : {}),
    candidateStatistics: Object.freeze(
      validated.candidateStatistics.map((statistic) =>
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

/** Creates an independently testable, registry-discoverable Research module. */
export function createResearchModule(): PipelineModule<
  ResearchRequest,
  ResearchResult,
  ResearchModuleServices
> {
  return defineModule({
    metadata: researchModuleMetadata,
    execute: executeResearch,
  });
}

/** Registers one Research module explicitly; registration itself has no execution side effect. */
export function registerResearchModule(
  registry: ModuleRegistry<ResearchModuleServices>,
  module: PipelineModule<
    ResearchRequest,
    ResearchResult,
    ResearchModuleServices
  > = createResearchModule(),
): ModuleRegistry<ResearchModuleServices> {
  return registry.register(module);
}

/**
 * Supplies the state-only adaptation that makes the module orchestrator-ready.
 * The binding never invokes the module directly; PipelineOrchestrator delegates
 * execution to ModuleRunner.runByKey() exclusively.
 */
export function createResearchModuleBinding(): OrchestratorModuleBinding<ResearchModuleServices> {
  return Object.freeze({
    key: RESEARCH_MODULE_KEY,
    createInput: (state: PipelineState): ResearchRequest => buildResearchRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => ({
      ...state,
      research: toResearchSection(assertValid(ResearchResultSchema, output, RESEARCH_MODULE_KEY)),
    }),
  });
}

async function executeResearch(
  input: ResearchRequest,
  context: ModuleExecutionContext<ResearchModuleServices>,
): Promise<ResearchResult> {
  const request = normalizeResearchRequest(input);
  const prompt = await context.services.promptRegistry.get('research', {
    topic: request.topic,
    targetAudience: request.targetAudience,
    keywordHints: formatPromptList(request.keywordHints),
    constraints: formatPromptList(request.constraints),
  });
  const response = await context.services.llmProvider.complete({
    moduleKey: RESEARCH_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: ResearchResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const parsed = parseJsonWithSchema(response.text, ResearchResultSchema, RESEARCH_MODULE_KEY);
    const result = freezeResearchResult({
      ...parsed,
      topic: request.topic,
      targetAudience: request.targetAudience,
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

function formatPromptList(values: readonly string[]): string {
  return values.length === 0 ? 'None provided' : values.join(', ');
}

function freezeResearchResult(result: ResearchResult): ResearchResult {
  return Object.freeze({
    topic: result.topic,
    targetAudience: result.targetAudience,
    searchIntent: result.searchIntent,
    primaryKeywords: freezeStrings(result.primaryKeywords),
    secondaryKeywords: freezeStrings(result.secondaryKeywords),
    competitorObservations: Object.freeze(
      result.competitorObservations.map((item) =>
        Object.freeze({ competitor: item.competitor, observation: item.observation }),
      ),
    ),
    questionsUsersAsk: freezeStrings(result.questionsUsersAsk),
    keyInsights: freezeStrings(result.keyInsights),
    references: Object.freeze(
      result.references.map((reference) =>
        Object.freeze({
          title: reference.title,
          source: reference.source,
          ...(reference.url === undefined ? {} : { url: reference.url }),
        }),
      ),
    ),
    ...(result.confidenceScore === undefined ? {} : { confidenceScore: result.confidenceScore }),
    suggestedAngle: result.suggestedAngle,
    candidateStatistics: Object.freeze(
      result.candidateStatistics.map((statistic) =>
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

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: 'success' | 'validationError',
) {
  if (!PROVIDER_NAMES.has(response.providerName)) {
    throw new ValidationError(RESEARCH_MODULE_KEY, [
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
