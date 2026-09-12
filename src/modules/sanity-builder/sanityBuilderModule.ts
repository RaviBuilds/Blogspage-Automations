/**
 * Sanity Document Builder module (module 19, registry key `sanity-builder`).
 *
 * Deterministically assembles the final `post` document (`sanity.document`)
 * from every prior section: title/slug/excerpt/SEO from planning + seo,
 * author/category from seeded references, mainImage + inline images from
 * `images.uploaded`, and content/FAQ from the Portable Text + FAQ sections.
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
  SanityPostDocumentSchema,
  SeoSectionSchema,
  type Brief,
  type DraftSection,
  type ImagesSection,
  type PipelineState,
  type PlanningSection,
  type SanityPostDocument,
  type SeoSection,
} from '@/core/state.js';
import { isoNow } from '@/lib/dates.js';
import { assertValid } from '@/lib/schemaValidator.js';
import { slugify } from '@/lib/slug.js';
import { inferCategory, SEEDED_AUTHORS } from '@/integrations/sanity/seedRefs.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';

const SANITY_BUILDER_MODULE_KEY = 'sanity-builder' as const;

/** Services injected by the composition root (uniform across the registry). */
export interface SanityBuilderModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Input Contract
// ============================================================================

export interface SanityBuilderRequest {
  readonly brief: Brief;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
  readonly draft: DraftSection;
  readonly images?: ImagesSection | undefined;
  readonly portableText?: readonly unknown[] | undefined;
  readonly faq?: readonly unknown[] | undefined;
}

export const SanityBuilderRequestSchema: z.ZodType<SanityBuilderRequest> = z
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

export interface SanityBuilderResult {
  readonly document: SanityPostDocument;
}

export const SanityBuilderResultSchema: z.ZodType<SanityBuilderResult> = z
  .object({
    document: SanityPostDocumentSchema,
  })
  .strict();

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const sanityBuilderModuleMetadata: ModuleMetadata = Object.freeze({
  key: SANITY_BUILDER_MODULE_KEY,
  displayName: 'Sanity Document Builder',
  description:
    'Assembles the final post document (title, slug, excerpt, SEO, seeded author/category refs, images, content, FAQ).',
  dependencies: Object.freeze([
    'internal-links',
    'portable-text',
    'faq-generator',
    'structured-data-check',
    'image-upload',
  ] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'portable-text.portable-content',
      'faq-generator.faq-items',
      'image-upload.uploaded-assets',
    ]),
    provides: Object.freeze(['sanity-builder.post-document']),
  }),
});

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Sanity Builder module. */
export function createSanityBuilderModule(): PipelineModule<
  SanityBuilderRequest,
  SanityBuilderResult,
  SanityBuilderModuleServices
> {
  return defineModule({
    metadata: sanityBuilderModuleMetadata,
    execute: executeSanityBuilder,
  });
}

/** Registers one Sanity Builder module without triggering execution. */
export function registerSanityBuilderModule(
  registry: ModuleRegistry<SanityBuilderModuleServices>,
  module: PipelineModule<
    SanityBuilderRequest,
    SanityBuilderResult,
    SanityBuilderModuleServices
  > = createSanityBuilderModule(),
): ModuleRegistry<SanityBuilderModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Sanity Builder module. */
export function createSanityBuilderModuleBinding(): OrchestratorModuleBinding<SanityBuilderModuleServices> {
  return Object.freeze({
    key: SANITY_BUILDER_MODULE_KEY,
    createInput: (state: PipelineState): SanityBuilderRequest => buildSanityBuilderRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(SanityBuilderResultSchema, output, SANITY_BUILDER_MODULE_KEY);
      return {
        ...state,
        sanity: {
          ...state.sanity,
          document: result.document,
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

/** Builds the module's input, requiring the content-producing sections. */
export function buildSanityBuilderRequest(state: PipelineState): SanityBuilderRequest {
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
  return new ValidationError(SANITY_BUILDER_MODULE_KEY, [
    `state.${section} is required to assemble the Sanity document.`,
  ]);
}

function executeSanityBuilder(
  input: SanityBuilderRequest,
  _context: ModuleExecutionContext<SanityBuilderModuleServices>,
): SanityBuilderResult {
  const request = assertValid(SanityBuilderRequestSchema, input, SANITY_BUILDER_MODULE_KEY);
  const document = buildSanityDocument(request);
  return deepFreeze({ document });
}

/**
 * Assembles the final post document from the pipeline outputs, applying the
 * same deterministic rules the structured-data check reported.
 */
export function buildSanityDocument(request: SanityBuilderRequest): SanityPostDocument {
  const title = (request.planning.titleCandidates[0] ?? request.seo.seoTitleDraft).trim();
  if (title.length === 0) {
    throw new ValidationError(SANITY_BUILDER_MODULE_KEY, [
      'A non-empty title is required to build the Sanity document.',
    ]);
  }

  const content = request.portableText ?? [];
  if (content.length === 0) {
    throw new ValidationError(SANITY_BUILDER_MODULE_KEY, [
      'sanity.portableText must be non-empty to build the Sanity document.',
    ]);
  }

  const hero = request.images?.uploaded?.find((upload) => upload.role === 'hero');

  return Object.freeze({
    _type: 'post',
    title,
    slug: Object.freeze({ _type: 'slug', current: slugify(title) }),
    excerpt: normalizeExcerpt(request.seo.metaDescriptionDraft, request.brief.topic),
    author: Object.freeze({ _type: 'reference', _ref: SEEDED_AUTHORS.RAVI }),
    publishedAt: isoNow(),
    categories: [
      Object.freeze({
        _type: 'reference',
        _ref: inferCategory(request.brief.topic, request.seo.seoKeywords),
        _key: 'cat1',
      }),
    ],
    ...(hero !== undefined
      ? {
          mainImage: Object.freeze({
            _type: 'image',
            alt: hero.altText,
            asset: Object.freeze({ _type: 'reference', _ref: hero.assetId }),
          }),
        }
      : {}),
    content: content as SanityPostDocument['content'],
    ...(request.faq !== undefined && request.faq.length > 0
      ? { faq: request.faq as SanityPostDocument['faq'] }
      : {}),
    focusKeyword: request.seo.focusKeyword,
    seoKeywords: Object.freeze([...request.seo.seoKeywords]),
    seoTitle: request.seo.seoTitleDraft,
    metaDescription: normalizeExcerpt(request.seo.metaDescriptionDraft, request.brief.topic),
    featured: false,
    evergreen: false,
  });
}

/**
 * Returns a publish-safe excerpt in the schema's hard 50–200 range,
 * deterministically (favour the SEO meta description).
 */
export function normalizeExcerpt(draft: string, topic: string): string {
  let excerpt = draft.trim().length > 0 ? draft.trim() : topic.trim();
  if (excerpt.length < 50) {
    excerpt = `${topic.trim()}. ${excerpt}`;
  }
  if (excerpt.length < 50) {
    excerpt = `${excerpt} Get practical, step-by-step guidance.`;
  }
  if (excerpt.length > 200) {
    excerpt = excerpt
      .slice(0, 200)
      .replace(/\s+\S*$/, '')
      .trim();
  }
  return excerpt;
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
