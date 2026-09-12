/**
 * Article Improver module (registry key `improver`).
 *
 * Invoked only when the QA Gate decided a draft needs revision. Performs a
 * targeted, bounded repair (never a rewrite): produces the full corrected
 * draft while preserving every marker and untouched sentence.
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
  DraftSchema,
  QaSectionSchema,
  type DraftSection,
  type PipelineState,
  type QaSection,
} from '@/core/state.js';
import { replaceDraft } from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const IMPROVER_MODULE_KEY = 'improver' as const;
const MAX_OUTPUT_TOKENS = 8_000;

const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** Services injected by the composition root. */
export interface ImproverModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface ImproverRequest {
  readonly qa: QaSection;
  readonly draft: DraftSection;
}

export const ImproverRequestSchema: z.ZodType<ImproverRequest> = z
  .object({
    qa: QaSectionSchema,
    draft: z
      .object({
        current: DraftSchema,
      })
      .passthrough() as unknown as z.ZodType<DraftSection>,
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export interface ImproverResult {
  readonly markdown: string;
  readonly wordCount: number;
  readonly linkMarkers: readonly { markerId: string; anchorTextHint: string }[];
  readonly imageMarkers: readonly {
    markerId: string;
    role: 'hero' | 'inline';
    descriptionHint: string;
  }[];
}

export const ImproverResultSchema: z.ZodType<ImproverResult> = DraftSchema;

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const improverModuleMetadata: ModuleMetadata = Object.freeze({
  key: IMPROVER_MODULE_KEY,
  displayName: 'Article Improver',
  description:
    'Applies the minimal targeted repair the QA Gate requested, preserving the rest of the draft and its markers.',
  dependencies: Object.freeze(['qa', 'reviewer-technical', 'reviewer-seo', 'humanizer'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze(['qa.decision', 'reviewer.technical-review', 'reviewer.seo-review']),
    provides: Object.freeze(['improver.repaired-draft']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Article Improver module. */
export function createImproverModule(): PipelineModule<
  ImproverRequest,
  ImproverResult,
  ImproverModuleServices
> {
  return defineModule({ metadata: improverModuleMetadata, execute: executeImprover });
}

/** Registers one Article Improver module without triggering execution. */
export function registerImproverModule(
  registry: ModuleRegistry<ImproverModuleServices>,
  module: PipelineModule<
    ImproverRequest,
    ImproverResult,
    ImproverModuleServices
  > = createImproverModule(),
): ModuleRegistry<ImproverModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Article Improver module. */
export function createImproverModuleBinding(): OrchestratorModuleBinding<ImproverModuleServices> {
  return Object.freeze({
    key: IMPROVER_MODULE_KEY,
    createInput: (state: PipelineState): ImproverRequest => buildImproverRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const draft = assertValid(ImproverResultSchema, output, IMPROVER_MODULE_KEY);
      return replaceDraft(state, 'improver', draft);
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input: the latest QA decision + current draft. */
export function buildImproverRequest(state: PipelineState): ImproverRequest {
  if (state.qa === undefined) {
    throw new ValidationError(IMPROVER_MODULE_KEY, [
      'state.qa is required; improver only runs after a needsRevision QA decision.',
    ]);
  }
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(IMPROVER_MODULE_KEY, [
      'state.draft.current is required to repair the article.',
    ]);
  }
  return { qa: state.qa, draft: state.draft };
}

async function executeImprover(
  input: ImproverRequest,
  context: ModuleExecutionContext<ImproverModuleServices>,
): Promise<ImproverResult> {
  const request = assertValid(ImproverRequestSchema, input, IMPROVER_MODULE_KEY);

  const prompt = await context.services.promptRegistry.get('improver', {
    draftMarkdown: request.draft.current.markdown,
    remainingIssuesAsMarkdownList: formatIssues(request.qa.remainingIssues),
  });

  const response = await context.services.llmProvider.complete({
    moduleKey: IMPROVER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, ImproverResultSchema, IMPROVER_MODULE_KEY),
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

function formatIssues(
  issues: readonly { id: string; severity: string; location: string; description: string }[],
): string {
  if (issues.length === 0) {
    return '- none remaining';
  }
  return issues
    .map((issue) => `- [${issue.severity}] ${issue.id} @ ${issue.location}: ${issue.description}`)
    .join('\n');
}

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: ModuleCostEventInput['outcome'],
): ModuleCostEventInput {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(IMPROVER_MODULE_KEY, [
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
