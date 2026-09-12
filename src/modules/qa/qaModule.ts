/**
 * QA Gate module (registry key `qa`).
 *
 * The bounded-loop gatekeeper: given the current review iteration and the
 * technical + SEO review results, it decides whether the draft passes, needs
 * another bounded revision pass, or must fail closed for a human. It writes
 * `state.qa`; the composition root turns that into orchestrator loop actions.
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
  QaSectionSchema,
  ReviewOutputSchema,
  type DraftSection,
  type PipelineState,
  type QaSection,
  type ReviewOutput,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const QA_MODULE_KEY = 'qa' as const;
const MAX_OUTPUT_TOKENS = 3_000;

const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** Services injected by the composition root. */
export interface QaModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface QaRequest {
  readonly draft: DraftSection;
  readonly technicalReview?: ReviewOutput | undefined;
  readonly seoReview?: ReviewOutput | undefined;
  readonly currentIteration: number;
  readonly maxIterations: number;
}

export const QaRequestSchema: z.ZodType<QaRequest> = z
  .object({
    draft: DraftSectionSchema,
    technicalReview: ReviewOutputSchema.optional(),
    seoReview: ReviewOutputSchema.optional(),
    currentIteration: z.number().int().min(0),
    maxIterations: z.number().int().min(1),
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export interface QaResult {
  readonly decision: 'pass' | 'needsRevision' | 'failClosed';
  readonly remainingIssues: QaSection['remainingIssues'];
}

export const QaResultSchema: z.ZodType<QaResult> = QaSectionSchema;

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const qaModuleMetadata: ModuleMetadata = Object.freeze({
  key: QA_MODULE_KEY,
  displayName: 'QA Gate',
  description:
    'Decides pass / needsRevision / failClosed from the technical + SEO reviews and the current loop iteration, writing state.qa.',
  dependencies: Object.freeze(['humanizer', 'reviewer-technical', 'reviewer-seo'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'reviewer.technical-review',
      'reviewer.seo-review',
    ]),
    provides: Object.freeze(['qa.decision']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable QA Gate module. */
export function createQaModule(): PipelineModule<QaRequest, QaResult, QaModuleServices> {
  return defineModule({ metadata: qaModuleMetadata, execute: executeQa });
}

/** Registers one QA Gate module without triggering execution. */
export function registerQaModule(
  registry: ModuleRegistry<QaModuleServices>,
  module: PipelineModule<QaRequest, QaResult, QaModuleServices> = createQaModule(),
): ModuleRegistry<QaModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the QA Gate module. */
export function createQaModuleBinding(): OrchestratorModuleBinding<QaModuleServices> {
  return Object.freeze({
    key: QA_MODULE_KEY,
    createInput: (state: PipelineState): QaRequest => buildQaRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(QaResultSchema, output, QA_MODULE_KEY);
      return {
        ...state,
        qa: result,
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input from the review + loop state. */
export function buildQaRequest(state: PipelineState, maxIterations: number = 3): QaRequest {
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(QA_MODULE_KEY, ['state.draft.current is required for the QA gate.']);
  }
  return {
    draft: state.draft,
    technicalReview: state.review?.technical,
    seoReview: state.review?.seo,
    currentIteration: state.review?.loop?.iteration ?? 0,
    maxIterations,
  };
}

async function executeQa(
  input: QaRequest,
  context: ModuleExecutionContext<QaModuleServices>,
): Promise<QaResult> {
  const request = assertValid(QaRequestSchema, input, QA_MODULE_KEY);

  const prompt = await context.services.promptRegistry.get('qa', {
    currentIteration: String(request.currentIteration),
    maxIterations: String(request.maxIterations),
    technicalReviewAsJson: JSON.stringify(request.technicalReview ?? { passed: true, issues: [] }),
    seoReviewAsJson: JSON.stringify(request.seoReview ?? { passed: true, issues: [] }),
  });

  const response = await context.services.llmProvider.complete({
    moduleKey: QA_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(parseJsonWithSchema(response.text, QaResultSchema, QA_MODULE_KEY));
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

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: ModuleCostEventInput['outcome'],
): ModuleCostEventInput {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(QA_MODULE_KEY, [
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
