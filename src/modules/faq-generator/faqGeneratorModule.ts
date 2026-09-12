/**
 * FAQ Generator module (module 17, registry key `faq-generator`).
 *
 * Produces 3-6 FAQ items grounded in the article draft. The result feeds the
 * site's render-time `FAQPage` structured data (`knowledge/blog-system.md`) and
 * is validated deterministically before it reaches `sanity.faq`.
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
  SeoSectionSchema,
  type DraftSection,
  type PipelineState,
  type SeoSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const FAQ_GENERATOR_MODULE_KEY = 'faq-generator' as const;
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_FAQ_ITEMS = 10;
const MIN_FAQ_ITEMS = 3;

const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** Services injected by the composition root. */
export interface FaqGeneratorModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface FaqGeneratorRequest {
  readonly seo: SeoSection;
  readonly draft: DraftSection;
}

export const FaqGeneratorRequestSchema: z.ZodType<FaqGeneratorRequest> = z
  .object({
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

/** A raw LLM-produced FAQ pair, before the binding adds `_type`/`_key`. */
export interface FaqItemDraft {
  readonly question: string;
  readonly answer: string;
}

export interface FaqGeneratorResult {
  readonly faq: readonly FaqItemDraft[];
}

/** The validated FAQ list the module produces, with deterministic count rules. */
export const FaqGeneratorResultSchema: z.ZodType<FaqGeneratorResult> = z
  .object({
    faq: z.array(
      z
        .object({
          question: z.string(),
          answer: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine(validateFaq);

function validateFaq(result: FaqGeneratorResult, ctx: z.RefinementCtx): void {
  const items = result.faq;
  if (items.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'No FAQ items returned; refusing an empty FAQ section.',
    });
    return;
  }
  if (items.length > MAX_FAQ_ITEMS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `FAQ must not exceed ${MAX_FAQ_ITEMS} items; found ${items.length}.`,
    });
  }
  if (items.length < MIN_FAQ_ITEMS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `FAQ should contain at least ${MIN_FAQ_ITEMS} items; found ${items.length}.`,
    });
  }

  const seenQuestions = new Set<string>();
  for (const [index, item] of items.entries()) {
    const question = item.question.trim();
    const answer = item.answer.trim();
    if (question.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `FAQ item ${index} has an empty question.`,
      });
    } else if (question.length > 160) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `FAQ item ${index} question exceeds 160 characters.`,
      });
    }
    const key = question.toLowerCase();
    if (seenQuestions.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `FAQ item ${index} duplicates question "${item.question}".`,
      });
    }
    seenQuestions.add(key);
    if (answer.length < 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `FAQ item ${index} answer must be at least 20 characters.`,
      });
    }
  }
}

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const faqGeneratorModuleMetadata: ModuleMetadata = Object.freeze({
  key: FAQ_GENERATOR_MODULE_KEY,
  displayName: 'FAQ Generator',
  description:
    'Produces 3-6 article-grounded FAQ items (question ≤ 160 chars, answer ≥ 20 chars) written to sanity.faq.',
  dependencies: Object.freeze(['seo-planner', 'writer', 'humanizer'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'writer.draft',
      'seo.focus-keyword',
    ]),
    provides: Object.freeze(['faq-generator.faq-items']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable FAQ Generator module. */
export function createFaqGeneratorModule(): PipelineModule<
  FaqGeneratorRequest,
  FaqGeneratorResult,
  FaqGeneratorModuleServices
> {
  return defineModule({
    metadata: faqGeneratorModuleMetadata,
    execute: executeFaqGenerator,
  });
}

/** Registers one FAQ Generator module without triggering execution. */
export function registerFaqGeneratorModule(
  registry: ModuleRegistry<FaqGeneratorModuleServices>,
  module: PipelineModule<
    FaqGeneratorRequest,
    FaqGeneratorResult,
    FaqGeneratorModuleServices
  > = createFaqGeneratorModule(),
): ModuleRegistry<FaqGeneratorModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the FAQ Generator module. */
export function createFaqGeneratorModuleBinding(): OrchestratorModuleBinding<FaqGeneratorModuleServices> {
  return Object.freeze({
    key: FAQ_GENERATOR_MODULE_KEY,
    createInput: (state: PipelineState): FaqGeneratorRequest => buildFaqGeneratorRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(FaqGeneratorResultSchema, output, FAQ_GENERATOR_MODULE_KEY);
      const keyed = result.faq.map((item, index) =>
        Object.freeze({
          _type: 'faqItem' as const,
          _key: `faq${String(index + 1)}`,
          question: item.question.trim(),
          answer: item.answer.trim(),
        }),
      );
      return {
        ...state,
        sanity: {
          ...state.sanity,
          faq: Object.freeze(keyed),
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, requiring seo + draft. */
export function buildFaqGeneratorRequest(state: PipelineState): FaqGeneratorRequest {
  if (state.seo === undefined) {
    throw new ValidationError(FAQ_GENERATOR_MODULE_KEY, [
      'state.seo is required to generate FAQ items.',
    ]);
  }
  if (state.draft === undefined || state.draft.current === undefined) {
    throw new ValidationError(FAQ_GENERATOR_MODULE_KEY, [
      'state.draft.current is required to generate FAQ items.',
    ]);
  }
  return { seo: state.seo, draft: state.draft };
}

async function executeFaqGenerator(
  input: FaqGeneratorRequest,
  context: ModuleExecutionContext<FaqGeneratorModuleServices>,
): Promise<FaqGeneratorResult> {
  const request = assertValid(FaqGeneratorRequestSchema, input, FAQ_GENERATOR_MODULE_KEY);

  const prompt = await context.services.promptRegistry.get('faq-generator', {
    draftMarkdown: request.draft.current.markdown,
    focusKeyword: request.seo.focusKeyword,
  });

  const response = await context.services.llmProvider.complete({
    moduleKey: FAQ_GENERATOR_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, FaqGeneratorResultSchema, FAQ_GENERATOR_MODULE_KEY),
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

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: ModuleCostEventInput['outcome'],
): ModuleCostEventInput {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(FAQ_GENERATOR_MODULE_KEY, [
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
