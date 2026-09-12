/**
 * SEO Reviewer module (reviewer-seo).
 *
 * Checks a finished draft against the SEO plan it was supposed to follow:
 * keyword placement/density, heading structure, and whether the drafted SEO
 * title/meta description still fit the article as actually written. It reviews
 * only; it does not rewrite. The structured output writes `review.seo`.
 */

import { z } from 'zod';

import { ValidationError } from '@/core/errors.js';
import {
  defineModule,
  type ModuleCostEventInput,
  type ModuleExecutionContext,
  type ModuleMetadata,
  type ModuleRegistry,
  type PipelineModule,
} from '@/core/moduleRunner.js';
import type { OrchestratorModuleBinding } from '@/core/orchestrator.js';
import {
  DraftSectionSchema,
  ReviewOutputSchema,
  SeoSectionSchema,
  type DraftSection,
  type PipelineState,
  type ReviewOutput,
  type SeoSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const SEO_REVIEWER_MODULE_KEY = 'reviewer-seo' as const;
const MAX_OUTPUT_TOKENS = 4_000;

const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** Services injected by the composition root. */
export interface SeoReviewerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface SeoReviewRequest {
  readonly seo: SeoSection;
  readonly draft: DraftSection;
}

export const SeoReviewRequestSchema: z.ZodType<SeoReviewRequest> = z
  .object({
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export type SeoReviewResult = ReviewOutput;

export const SeoReviewResultSchema: z.ZodType<SeoReviewResult> = ReviewOutputSchema;

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const seoReviewerModuleMetadata: ModuleMetadata = Object.freeze({
  key: SEO_REVIEWER_MODULE_KEY,
  displayName: 'SEO Reviewer',
  description:
    'Checks the finished draft against the SEO plan (keyword placement, heading structure, SEO title/meta fit), writing review.seo.',
  dependencies: Object.freeze(['seo-planner', 'writer', 'humanizer'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'seo.strategy',
      'writer.draft',
    ]),
    provides: Object.freeze(['reviewer.seo-review']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable SEO Reviewer module. */
export function createSeoReviewerModule(): PipelineModule<
  SeoReviewRequest,
  SeoReviewResult,
  SeoReviewerModuleServices
> {
  return defineModule({
    metadata: seoReviewerModuleMetadata,
    execute: executeSeoReviewer,
  });
}

/** Registers one SEO Reviewer module without triggering execution. */
export function registerSeoReviewerModule(
  registry: ModuleRegistry<SeoReviewerModuleServices>,
  module: PipelineModule<
    SeoReviewRequest,
    SeoReviewResult,
    SeoReviewerModuleServices
  > = createSeoReviewerModule(),
): ModuleRegistry<SeoReviewerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the SEO Reviewer module. */
export function createSeoReviewerModuleBinding(): OrchestratorModuleBinding<SeoReviewerModuleServices> {
  return Object.freeze({
    key: SEO_REVIEWER_MODULE_KEY,
    createInput: (state: PipelineState): SeoReviewRequest => buildSeoReviewRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(SeoReviewResultSchema, output, SEO_REVIEWER_MODULE_KEY);
      return {
        ...state,
        review: {
          ...state.review,
          seo: result,
          loop: state.review?.loop ?? { iteration: 0 },
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, requiring the seo + draft sections. */
export function buildSeoReviewRequest(state: PipelineState): SeoReviewRequest {
  if (state.seo === undefined) {
    throw new ValidationError(SEO_REVIEWER_MODULE_KEY, ['state.seo is required to review SEO.']);
  }
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(SEO_REVIEWER_MODULE_KEY, [
      'state.draft.current is required to review SEO.',
    ]);
  }
  return { seo: state.seo, draft: state.draft };
}

async function executeSeoReviewer(
  input: SeoReviewRequest,
  context: ModuleExecutionContext<SeoReviewerModuleServices>,
): Promise<SeoReviewResult> {
  const request = assertValid(SeoReviewRequestSchema, input, SEO_REVIEWER_MODULE_KEY);

  const prompt = await context.services.promptRegistry.get('reviewer-seo', {
    draftMarkdown: request.draft.current.markdown,
    focusKeyword: request.seo.focusKeyword,
    seoKeywordsAsMarkdownList: formatList(request.seo.seoKeywords),
    seoTitleDraft: request.seo.seoTitleDraft,
    metaDescriptionDraft: request.seo.metaDescriptionDraft,
  });

  const response = await context.services.llmProvider.complete({
    moduleKey: SEO_REVIEWER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, SeoReviewResultSchema, SEO_REVIEWER_MODULE_KEY),
    );
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return result;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '- none' : values.map((value) => `- ${value}`).join('\n');
}

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: ModuleCostEventInput['outcome'],
): ModuleCostEventInput {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(SEO_REVIEWER_MODULE_KEY, [
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
    return Object.freeze(value.map((item: unknown) => deepFreeze(item))) as T;
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])),
    ) as T;
  }
  return value;
}
