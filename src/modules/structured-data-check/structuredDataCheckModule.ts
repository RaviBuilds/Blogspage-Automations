/**
 * Structured-Data Readiness Validator module (module 18, registry key
 * `structured-data-check`).
 *
 * Deterministically checks the pipeline output against the required-post
 * contract (`knowledge/automation-integration.md`) before the Sanity builder
 * assembles the document, and records what it auto-filled.
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
  DraftSectionSchema,
  ImagesSectionSchema,
  PlanningSectionSchema,
  SeoSectionSchema,
  StructuredDataCheckSchema,
  type Brief,
  type DraftSection,
  type ImagesSection,
  type PipelineState,
  type PlanningSection,
  type SeoSection,
  type StructuredDataCheck,
} from '@/core/state.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';

const STRUCTURED_DATA_CHECK_MODULE_KEY = 'structured-data-check' as const;

/** Services injected by the composition root (uniform across the registry). */
export interface StructuredDataCheckModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface StructuredDataCheckRequest {
  readonly brief: Brief;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
  readonly draft: DraftSection;
  readonly images?: ImagesSection | undefined;
  readonly portableText?: readonly unknown[] | undefined;
  readonly faq?: readonly unknown[] | undefined;
}

export const StructuredDataCheckRequestSchema: z.ZodType<StructuredDataCheckRequest> = z
  .object({
    brief: BriefSchema,
    planning: PlanningSectionSchema,
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
    images: ImagesSectionSchema.optional(),
    portableText: z.array(z.unknown()).optional(),
    faq: z.array(z.unknown()).optional(),
  })
  .strict();

// ============================================================================
// Output Contract
// ============================================================================

export interface StructuredDataCheckResult {
  readonly check: StructuredDataCheck;
}

export const StructuredDataCheckResultSchema: z.ZodType<StructuredDataCheckResult> = z
  .object({
    check: StructuredDataCheckSchema,
  })
  .strict();

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const structuredDataCheckModuleMetadata: ModuleMetadata = Object.freeze({
  key: STRUCTURED_DATA_CHECK_MODULE_KEY,
  displayName: 'Structured Data Check',
  description:
    'Validates that the assembled pipeline output satisfies the required-post contract, returning ready/missing/autoFilled.',
  dependencies: Object.freeze(['internal-links', 'portable-text', 'faq-generator'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'internal-links.resolved-links',
      'portable-text.portable-content',
      'faq-generator.faq-items',
    ]),
    provides: Object.freeze(['structured-data-check.readiness']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Structured Data Check module. */
export function createStructuredDataCheckModule(): PipelineModule<
  StructuredDataCheckRequest,
  StructuredDataCheckResult,
  StructuredDataCheckModuleServices
> {
  return defineModule({
    metadata: structuredDataCheckModuleMetadata,
    execute: executeStructuredDataCheck,
  });
}

/** Registers one Structured Data Check module without triggering execution. */
export function registerStructuredDataCheckModule(
  registry: ModuleRegistry<StructuredDataCheckModuleServices>,
  module: PipelineModule<
    StructuredDataCheckRequest,
    StructuredDataCheckResult,
    StructuredDataCheckModuleServices
  > = createStructuredDataCheckModule(),
): ModuleRegistry<StructuredDataCheckModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the module. */
export function createStructuredDataCheckModuleBinding(): OrchestratorModuleBinding<StructuredDataCheckModuleServices> {
  return Object.freeze({
    key: STRUCTURED_DATA_CHECK_MODULE_KEY,
    createInput: (state: PipelineState): StructuredDataCheckRequest =>
      buildStructuredDataCheckRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(
        StructuredDataCheckResultSchema,
        output,
        STRUCTURED_DATA_CHECK_MODULE_KEY,
      );
      return {
        ...state,
        sanity: {
          ...state.sanity,
          structuredDataCheck: result.check,
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, requiring the content-producing sections. */
export function buildStructuredDataCheckRequest(state: PipelineState): StructuredDataCheckRequest {
  if (state.brief === undefined) throw missingValidation('brief');
  if (state.planning === undefined) throw missingValidation('planning');
  if (state.seo === undefined) throw missingValidation('seo');
  if (state.draft === undefined) throw missingValidation('draft');
  return {
    brief: state.brief,
    planning: state.planning,
    seo: state.seo,
    draft: state.draft,
    images: state.images,
    portableText: state.sanity?.portableText,
    faq: state.sanity?.faq,
  };
}

function missingValidation(section: string): ValidationError {
  return new ValidationError(STRUCTURED_DATA_CHECK_MODULE_KEY, [
    `state.${section} is required for the structured-data readiness check.`,
  ]);
}

function executeStructuredDataCheck(
  input: StructuredDataCheckRequest,
  _context: ModuleExecutionContext<StructuredDataCheckModuleServices>,
): StructuredDataCheckResult {
  const request = assertValid(
    StructuredDataCheckRequestSchema,
    input,
    STRUCTURED_DATA_CHECK_MODULE_KEY,
  );
  const check = runStructuredDataCheck(request);
  return deepFreeze({ check });
}

/**
 * Runs the required-post checks. Missing items are reported; auto-filled items
 * are recorded so the Sanity builder knows the fix was applied centrally.
 */
export function runStructuredDataCheck(request: StructuredDataCheckRequest): StructuredDataCheck {
  const missing: string[] = [];
  const autoFilled: string[] = [];

  const title = request.planning.titleCandidates[0]?.trim() ?? request.seo.seoTitleDraft.trim();
  if (title.length < 15 || title.length > 90) {
    missing.push('title (15-90 chars)');
  }

  const excerpt = request.seo.metaDescriptionDraft.trim();
  if (excerpt.length < 50 || excerpt.length > 200) {
    missing.push('excerpt (50-200 chars)');
  }

  if ((request.portableText?.length ?? 0) === 0) {
    missing.push('content (portableText is empty)');
  }

  if (request.seo.focusKeyword.trim().length === 0) {
    missing.push('focusKeyword');
  }

  if ((request.images?.uploaded?.length ?? 0) === 0) {
    autoFilled.push('mainImage (no images attached; OG falls back to the site default)');
  }

  if ((request.faq?.length ?? 0) > 0) {
    autoFilled.push('faq (FAQPage structured data will be emitted)');
  }

  autoFilled.push('publishedAt (set to now by the Sanity builder)');
  autoFilled.push('author (seeded author-ravi)');

  return Object.freeze({
    ready: missing.length === 0,
    missing: Object.freeze(missing),
    autoFilled: Object.freeze(autoFilled),
  });
}

// ============================================================================
// Internal Helpers
// ============================================================================

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
