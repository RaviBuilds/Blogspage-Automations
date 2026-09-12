/**
 * Provider-agnostic Publisher module.
 *
 * The module assembles a complete, immutable PublishArtifact from the pipeline
 * outputs. It does NOT publish to external systems, call APIs, write files,
 * or perform deployment. It only builds the artifact that downstream adapters
 * may consume for actual publishing operations.
 *
 * Provider invocation, timing, cost-event persistence, scheduling, and
 * checkpointing remain owned by ModuleRunner and PipelineOrchestrator.
 */

import { createHash } from 'node:crypto';
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
  PlanningSectionSchema,
  ResearchSectionSchema,
  ReviewSectionSchema,
  SeoSectionSchema,
  type Brief,
  type DraftSection,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type ReviewSection,
  type SeoSection,
} from '@/core/state.js';
import { estimateReadingTimeMinutes } from '@/lib/readingTime.js';
import { assertValid } from '@/lib/schemaValidator.js';

const PUBLISHER_MODULE_KEY = 'publish' as const;
const ARTIFACT_VERSION = 1;
const PIPELINE_VERSION = '7H';

// ============================================================================
// Input Contract
// ============================================================================

/**
 * Stable, persisted inputs available to the Publisher through PipelineState.
 * The module requires brief, research, planning, SEO, draft, and review sections
 * to assemble the complete publish artifact.
 */
export interface PublishRequest {
  readonly brief: Brief;
  readonly research: ResearchSection;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
  readonly draft: DraftSection;
  readonly review: ReviewSection;
}

export const PublishRequestSchema: z.ZodType<PublishRequest> = z
  .object({
    brief: BriefSchema,
    research: ResearchSectionSchema,
    planning: PlanningSectionSchema,
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
    review: ReviewSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract - Publish Artifact
// ============================================================================

/** Content section of the publish artifact. */
export interface ContentArtifact {
  /** Final markdown content. */
  readonly markdown: string;
  /** HTML representation. */
  readonly html: string;
  /** Plain text representation. */
  readonly plainText: string;
}

const ContentArtifactSchema: z.ZodType<ContentArtifact> = z
  .object({
    markdown: z.string().min(1),
    html: z.string().min(1),
    plainText: z.string().min(1),
  })
  .strict();

/** Metadata section of the publish artifact. */
export interface MetadataArtifact {
  /** Article title. */
  readonly title: string;
  /** URL slug. */
  readonly slug: string;
  /** Meta description. */
  readonly description: string;
  /** Tags for categorization. */
  readonly tags: readonly string[];
  /** Category assignments. */
  readonly categories: readonly string[];
  /** Canonical URL placeholder (to be resolved by adapter). */
  readonly canonicalUrlPlaceholder: string;
  /** Publish date placeholder (to be resolved by adapter). */
  readonly publishDatePlaceholder: string;
  /** Estimated reading time in minutes. */
  readonly readingTimeMinutes: number;
  /** ISO 8601 duration for reading time. */
  readonly readingTimeIsoDuration: string;
  /** Word count. */
  readonly wordCount: number;
}

const MetadataArtifactSchema: z.ZodType<MetadataArtifact> = z
  .object({
    title: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)),
    categories: z.array(z.string().min(1)),
    canonicalUrlPlaceholder: z.string().min(1),
    publishDatePlaceholder: z.string().min(1),
    readingTimeMinutes: z.number().int().min(1),
    readingTimeIsoDuration: z.string().min(1),
    wordCount: z.number().int().min(1),
  })
  .strict();

/** OpenGraph metadata. */
export interface OpenGraphMetadata {
  readonly ogTitle: string;
  readonly ogDescription: string;
  readonly ogType: string;
  readonly ogImageAlt: string;
}

const OpenGraphMetadataSchema: z.ZodType<OpenGraphMetadata> = z
  .object({
    ogTitle: z.string().min(1),
    ogDescription: z.string().min(1),
    ogType: z.string().min(1),
    ogImageAlt: z.string().min(1),
  })
  .strict();

/** Twitter metadata. */
export interface TwitterMetadata {
  readonly twitterCard: 'summary' | 'summary_large_image';
  readonly twitterTitle: string;
  readonly twitterDescription: string;
  readonly twitterImageAlt: string;
}

const TwitterMetadataSchema: z.ZodType<TwitterMetadata> = z
  .object({
    twitterCard: z.enum(['summary', 'summary_large_image']),
    twitterTitle: z.string().min(1),
    twitterDescription: z.string().min(1),
    twitterImageAlt: z.string().min(1),
  })
  .strict();

/** SEO section of the publish artifact. */
export interface SeoArtifact {
  /** Meta title. */
  readonly metaTitle: string;
  /** Meta description. */
  readonly metaDescription: string;
  /** OpenGraph metadata. */
  readonly openGraph: OpenGraphMetadata;
  /** Twitter metadata. */
  readonly twitter: TwitterMetadata;
  /** JSON-LD structured data. */
  readonly jsonLd: string;
}

const SeoArtifactSchema: z.ZodType<SeoArtifact> = z
  .object({
    metaTitle: z.string().min(1),
    metaDescription: z.string().min(1),
    openGraph: OpenGraphMetadataSchema,
    twitter: TwitterMetadataSchema,
    jsonLd: z.string().min(1),
  })
  .strict();

/** Image reference in the artifact. */
export interface ImageReference {
  readonly id: string;
  readonly role: 'hero' | 'inline';
  readonly altText: string;
  readonly caption?: string | undefined;
}

const ImageReferenceSchema: z.ZodType<ImageReference> = z
  .object({
    id: z.string().min(1),
    role: z.enum(['hero', 'inline']),
    altText: z.string().min(1),
    caption: z.string().min(1).optional(),
  })
  .strict();

/** Assets section of the publish artifact. */
export interface AssetsArtifact {
  /** Featured image reference. */
  readonly featuredImage: ImageReference;
  /** All image references including featured. */
  readonly imageManifest: readonly ImageReference[];
  /** Alt text manifest keyed by image id. */
  readonly altTextManifest: readonly { readonly imageId: string; readonly altText: string }[];
  /** Caption manifest keyed by image id. */
  readonly captionManifest: readonly { readonly imageId: string; readonly caption: string }[];
}

const AssetsArtifactSchema: z.ZodType<AssetsArtifact> = z
  .object({
    featuredImage: ImageReferenceSchema,
    imageManifest: z.array(ImageReferenceSchema).min(1),
    altTextManifest: z.array(
      z.object({ imageId: z.string().min(1), altText: z.string().min(1) }).strict(),
    ),
    captionManifest: z.array(
      z.object({ imageId: z.string().min(1), caption: z.string().min(1) }).strict(),
    ),
  })
  .strict();

/** FAQ schema item. */
export interface FaqSchemaItem {
  readonly question: string;
  readonly answer: string;
}

const FaqSchemaItemSchema: z.ZodType<FaqSchemaItem> = z
  .object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();

/** CTA block in the artifact. */
export interface CtaBlock {
  readonly id: string;
  readonly headline: string;
  readonly description: string;
  readonly primaryButtonText: string;
  readonly secondaryButtonText?: string | undefined;
  readonly secondaryButtonUrl?: string | undefined;
}

const CtaBlockSchema: z.ZodType<CtaBlock> = z
  .object({
    id: z.string().min(1),
    headline: z.string().min(1),
    description: z.string().min(1),
    primaryButtonText: z.string().min(1),
    secondaryButtonText: z.string().min(1).optional(),
    secondaryButtonUrl: z.string().min(1).optional(),
  })
  .strict();

/** Related article reference. */
export interface RelatedArticleReference {
  readonly suggestedTitle: string;
  readonly relevanceReason: string;
}

const RelatedArticleReferenceSchema: z.ZodType<RelatedArticleReference> = z
  .object({
    suggestedTitle: z.string().min(1),
    relevanceReason: z.string().min(1),
  })
  .strict();

/** Internal link reference. */
export interface InternalLinkReference {
  readonly anchorText: string;
  readonly suggestedTargetTopic: string;
}

const InternalLinkReferenceSchema: z.ZodType<InternalLinkReference> = z
  .object({
    anchorText: z.string().min(1),
    suggestedTargetTopic: z.string().min(1),
  })
  .strict();

/** Structured content section of the publish artifact. */
export interface StructuredContentArtifact {
  /** FAQ schema items. */
  readonly faqSchema: readonly FaqSchemaItem[];
  /** CTA blocks. */
  readonly ctaBlocks: readonly CtaBlock[];
  /** Related article suggestions. */
  readonly relatedArticles: readonly RelatedArticleReference[];
  /** Internal link opportunities. */
  readonly internalLinks: readonly InternalLinkReference[];
}

const StructuredContentArtifactSchema: z.ZodType<StructuredContentArtifact> = z
  .object({
    faqSchema: z.array(FaqSchemaItemSchema),
    ctaBlocks: z.array(CtaBlockSchema),
    relatedArticles: z.array(RelatedArticleReferenceSchema),
    internalLinks: z.array(InternalLinkReferenceSchema),
  })
  .strict();

/** Validation issue in the artifact. */
export interface ValidationIssue {
  readonly severity: 'warning' | 'error';
  readonly field: string;
  readonly message: string;
}

const ValidationIssueSchema: z.ZodType<ValidationIssue> = z
  .object({
    severity: z.enum(['warning', 'error']),
    field: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/** Validation section of the publish artifact. */
export interface ValidationArtifact {
  /** Overall validation summary. */
  readonly summary: 'valid' | 'warnings' | 'errors';
  /** Missing assets list. */
  readonly missingAssets: readonly string[];
  /** Validation warnings. */
  readonly warnings: readonly ValidationIssue[];
  /** Validation errors. */
  readonly errors: readonly ValidationIssue[];
}

const ValidationArtifactSchema: z.ZodType<ValidationArtifact> = z
  .object({
    summary: z.enum(['valid', 'warnings', 'errors']),
    missingAssets: z.array(z.string()),
    warnings: z.array(ValidationIssueSchema),
    errors: z.array(ValidationIssueSchema),
  })
  .strict();

/** Checksums section of the publish artifact. */
export interface ChecksumArtifact {
  /** SHA-256 hash of the markdown content. */
  readonly contentHash: string;
  /** Artifact schema version. */
  readonly artifactVersion: number;
  /** Pipeline version that produced this artifact. */
  readonly pipelineVersion: string;
  /** ISO 8601 timestamp when artifact was built. */
  readonly buildTimestamp: string;
}

const ChecksumArtifactSchema: z.ZodType<ChecksumArtifact> = z
  .object({
    contentHash: z.string().min(1),
    artifactVersion: z.number().int().min(1),
    pipelineVersion: z.string().min(1),
    buildTimestamp: z.string().min(1),
  })
  .strict();

/**
 * The complete immutable publish artifact exposed to downstream adapters.
 * This is the rich output that provides everything needed for publishing
 * without actually performing any publishing operations.
 */
export interface PublishArtifact {
  /** Content representations. */
  readonly content: ContentArtifact;
  /** Metadata. */
  readonly metadata: MetadataArtifact;
  /** SEO data. */
  readonly seo: SeoArtifact;
  /** Asset references. */
  readonly assets: AssetsArtifact;
  /** Structured content. */
  readonly structuredContent: StructuredContentArtifact;
  /** Validation summary. */
  readonly validation: ValidationArtifact;
  /** Checksums and versioning. */
  readonly checksums: ChecksumArtifact;
}

export const PublishArtifactSchema: z.ZodType<PublishArtifact> = z
  .object({
    content: ContentArtifactSchema,
    metadata: MetadataArtifactSchema,
    seo: SeoArtifactSchema,
    assets: AssetsArtifactSchema,
    structuredContent: StructuredContentArtifactSchema,
    validation: ValidationArtifactSchema,
    checksums: ChecksumArtifactSchema,
  })
  .strict();

/** JSON Schema for PublishArtifact (for providers that support it). */
export const PublishArtifactJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'content',
    'metadata',
    'seo',
    'assets',
    'structuredContent',
    'validation',
    'checksums',
  ],
  properties: {
    content: {
      type: 'object',
      additionalProperties: false,
      required: ['markdown', 'html', 'plainText'],
      properties: {
        markdown: { type: 'string' },
        html: { type: 'string' },
        plainText: { type: 'string' },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title',
        'slug',
        'description',
        'tags',
        'categories',
        'canonicalUrlPlaceholder',
        'publishDatePlaceholder',
        'readingTimeMinutes',
        'readingTimeIsoDuration',
        'wordCount',
      ],
      properties: {
        title: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        categories: { type: 'array', items: { type: 'string' } },
        canonicalUrlPlaceholder: { type: 'string' },
        publishDatePlaceholder: { type: 'string' },
        readingTimeMinutes: { type: 'integer', minimum: 1 },
        readingTimeIsoDuration: { type: 'string' },
        wordCount: { type: 'integer', minimum: 1 },
      },
    },
    seo: {
      type: 'object',
      additionalProperties: false,
      required: ['metaTitle', 'metaDescription', 'openGraph', 'twitter', 'jsonLd'],
      properties: {
        metaTitle: { type: 'string' },
        metaDescription: { type: 'string' },
        openGraph: {
          type: 'object',
          additionalProperties: false,
          required: ['ogTitle', 'ogDescription', 'ogType', 'ogImageAlt'],
          properties: {
            ogTitle: { type: 'string' },
            ogDescription: { type: 'string' },
            ogType: { type: 'string' },
            ogImageAlt: { type: 'string' },
          },
        },
        twitter: {
          type: 'object',
          additionalProperties: false,
          required: ['twitterCard', 'twitterTitle', 'twitterDescription', 'twitterImageAlt'],
          properties: {
            twitterCard: { type: 'string', enum: ['summary', 'summary_large_image'] },
            twitterTitle: { type: 'string' },
            twitterDescription: { type: 'string' },
            twitterImageAlt: { type: 'string' },
          },
        },
        jsonLd: { type: 'string' },
      },
    },
    assets: {
      type: 'object',
      additionalProperties: false,
      required: ['featuredImage', 'imageManifest', 'altTextManifest', 'captionManifest'],
      properties: {
        featuredImage: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'role', 'altText'],
          properties: {
            id: { type: 'string' },
            role: { type: 'string', enum: ['hero', 'inline'] },
            altText: { type: 'string' },
            caption: { type: 'string' },
          },
        },
        imageManifest: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'role', 'altText'],
            properties: {
              id: { type: 'string' },
              role: { type: 'string', enum: ['hero', 'inline'] },
              altText: { type: 'string' },
              caption: { type: 'string' },
            },
          },
        },
        altTextManifest: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['imageId', 'altText'],
            properties: {
              imageId: { type: 'string' },
              altText: { type: 'string' },
            },
          },
        },
        captionManifest: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['imageId', 'caption'],
            properties: {
              imageId: { type: 'string' },
              caption: { type: 'string' },
            },
          },
        },
      },
    },
    structuredContent: {
      type: 'object',
      additionalProperties: false,
      required: ['faqSchema', 'ctaBlocks', 'relatedArticles', 'internalLinks'],
      properties: {
        faqSchema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['question', 'answer'],
            properties: {
              question: { type: 'string' },
              answer: { type: 'string' },
            },
          },
        },
        ctaBlocks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'headline', 'description', 'primaryButtonText'],
            properties: {
              id: { type: 'string' },
              headline: { type: 'string' },
              description: { type: 'string' },
              primaryButtonText: { type: 'string' },
              secondaryButtonText: { type: 'string' },
              secondaryButtonUrl: { type: 'string' },
            },
          },
        },
        relatedArticles: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['suggestedTitle', 'relevanceReason'],
            properties: {
              suggestedTitle: { type: 'string' },
              relevanceReason: { type: 'string' },
            },
          },
        },
        internalLinks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['anchorText', 'suggestedTargetTopic'],
            properties: {
              anchorText: { type: 'string' },
              suggestedTargetTopic: { type: 'string' },
            },
          },
        },
      },
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'missingAssets', 'warnings', 'errors'],
      properties: {
        summary: { type: 'string', enum: ['valid', 'warnings', 'errors'] },
        missingAssets: { type: 'array', items: { type: 'string' } },
        warnings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'field', 'message'],
            properties: {
              severity: { type: 'string', enum: ['warning', 'error'] },
              field: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'field', 'message'],
            properties: {
              severity: { type: 'string', enum: ['warning', 'error'] },
              field: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    checksums: {
      type: 'object',
      additionalProperties: false,
      required: ['contentHash', 'artifactVersion', 'pipelineVersion', 'buildTimestamp'],
      properties: {
        contentHash: { type: 'string' },
        artifactVersion: { type: 'integer', minimum: 1 },
        pipelineVersion: { type: 'string' },
        buildTimestamp: { type: 'string' },
      },
    },
  },
});

// ============================================================================
// Module Services Contract
// ============================================================================

/**
 * Services injected by the composition root.
 * The Publisher does NOT require LLMProvider - it operates deterministically.
 */
export type PublisherModuleServices = Record<string, unknown>;

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const publisherModuleMetadata: ModuleMetadata = Object.freeze({
  key: PUBLISHER_MODULE_KEY,
  displayName: 'Publisher',
  description:
    'Assembles a complete, immutable PublishArtifact from pipeline outputs without performing any publishing operations.',
  dependencies: Object.freeze([
    'research',
    'planner',
    'seo-planner',
    'writer',
    'reviewer-technical',
    'humanizer',
    'content-assets-planner',
  ] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'research.structured-output',
      'planner.content-plan',
      'seo.strategy',
      'writer.draft',
      'reviewer.technical-review',
      'humanizer.humanized-draft',
      'content-assets-planner.asset-blueprint',
    ]),
    provides: Object.freeze(['publisher.publish-artifact', 'publisher.state-projection']),
  }),
});

// ============================================================================
// State Projection Functions
// ============================================================================

/** Minimal publish section projected into PipelineState. */
export interface PublishSection {
  /** Whether artifact is valid for publishing. */
  readonly isValid: boolean;
  /** Number of validation warnings. */
  readonly warningCount: number;
  /** Number of validation errors. */
  readonly errorCount: number;
  /** Content hash for integrity. */
  readonly contentHash: string;
  /** Artifact version. */
  readonly artifactVersion: number;
}

/** Builds a validated request from the module-owned PipelineState reads. */
export function buildPublishRequest(state: PipelineState): PublishRequest {
  if (state.brief === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, ['state.brief is required.']);
  }
  if (state.research === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, ['state.research is required.']);
  }
  if (state.planning === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, ['state.planning is required.']);
  }
  if (state.seo === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, ['state.seo is required.']);
  }
  if (state.draft === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, ['state.draft is required.']);
  }
  if (state.review === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, ['state.review is required.']);
  }

  return normalizePublishRequest({
    brief: assertValid(BriefSchema, state.brief, PUBLISHER_MODULE_KEY),
    research: assertValid(ResearchSectionSchema, state.research, PUBLISHER_MODULE_KEY),
    planning: assertValid(PlanningSectionSchema, state.planning, PUBLISHER_MODULE_KEY),
    seo: assertValid(SeoSectionSchema, state.seo, PUBLISHER_MODULE_KEY),
    draft: assertValid(DraftSectionSchema, state.draft, PUBLISHER_MODULE_KEY),
    review: assertValid(ReviewSectionSchema, state.review, PUBLISHER_MODULE_KEY),
  });
}

/** Validates and freezes the Publisher module input contract. */
export function normalizePublishRequest(request: PublishRequest): PublishRequest {
  const parsed = assertValid(PublishRequestSchema, request, PUBLISHER_MODULE_KEY);
  return deepFreeze({
    brief: parsed.brief,
    research: parsed.research,
    planning: parsed.planning,
    seo: parsed.seo,
    draft: parsed.draft,
    review: parsed.review,
  });
}

/**
 * Projects the rich publish artifact into the minimal PipelineState section.
 * This maintains backward compatibility with the existing state model.
 */
export function toPublishSection(artifact: PublishArtifact): PublishSection {
  const validated = assertValid(PublishArtifactSchema, artifact, PUBLISHER_MODULE_KEY);

  return deepFreeze({
    isValid:
      validated.validation.summary === 'valid' || validated.validation.summary === 'warnings',
    warningCount: validated.validation.warnings.length,
    errorCount: validated.validation.errors.length,
    contentHash: validated.checksums.contentHash,
    artifactVersion: validated.checksums.artifactVersion,
  });
}

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Publisher module. */
export function createPublisherModule(): PipelineModule<
  PublishRequest,
  PublishArtifact,
  PublisherModuleServices
> {
  return defineModule({
    metadata: publisherModuleMetadata,
    execute: executePublisher,
  });
}

/** Registers one Publisher module without triggering execution. */
export function registerPublisherModule(
  registry: ModuleRegistry<PublisherModuleServices>,
  module: PipelineModule<
    PublishRequest,
    PublishArtifact,
    PublisherModuleServices
  > = createPublisherModule(),
): ModuleRegistry<PublisherModuleServices> {
  return registry.register(module);
}

/**
 * Creates the orchestrator-only state adapter for the Publisher module.
 *
 * The binding is deliberately generic over TServices: it never touches the
 * dependency-injected services (the publisher is deterministic), so it can be
 * instantiated against any pipeline-wide services type. The default keeps
 * module-local callers (`createPublisherModuleBinding()`) working unchanged.
 */
export function createPublisherModuleBinding<
  TServices extends object = PublisherModuleServices,
>(): OrchestratorModuleBinding<TServices> {
  return Object.freeze({
    key: PUBLISHER_MODULE_KEY,
    createInput: (state: PipelineState): PublishRequest => buildPublishRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const artifact = assertValid(PublishArtifactSchema, output, PUBLISHER_MODULE_KEY);
      const publishSection = toPublishSection(artifact);

      return {
        ...state,
        publish: publishSection,
      } as PipelineState & { publish: PublishSection };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

function executePublisher(
  input: PublishRequest,
  context: ModuleExecutionContext<PublisherModuleServices>,
): PublishArtifact {
  const request = normalizePublishRequest(input);
  const buildTimestamp = context.startedAt;

  // Build content artifact
  const markdown = request.draft.current.markdown;
  const content = buildContentArtifact(markdown);

  // Build metadata artifact
  const metadata = buildMetadataArtifact(request);

  // Build SEO artifact
  const seo = buildSeoArtifact(request);

  // Build assets artifact
  const assets = buildAssetsArtifact(request);

  // Build structured content artifact
  const structuredContent = buildStructuredContentArtifact(request);

  // Build validation artifact
  const validation = buildValidationArtifact(request, assets);

  // Build checksums
  const checksums = buildChecksumArtifact(markdown, buildTimestamp);

  const artifact: PublishArtifact = deepFreeze({
    content,
    metadata,
    seo,
    assets,
    structuredContent,
    validation,
    checksums,
  });

  // Validate the final artifact
  assertValid(PublishArtifactSchema, artifact, PUBLISHER_MODULE_KEY);

  // No cost recording needed - this module is deterministic and does not call LLM

  return artifact;
}

// ============================================================================
// Artifact Builders
// ============================================================================

function buildContentArtifact(markdown: string): ContentArtifact {
  return deepFreeze({
    markdown,
    html: markdownToHtml(markdown),
    plainText: markdownToPlainText(markdown),
  });
}

function buildMetadataArtifact(request: PublishRequest): MetadataArtifact {
  const wordCount = request.draft.current.wordCount;
  const readingTimeMinutes = estimateReadingTimeMinutes(wordCount);

  return deepFreeze({
    title: request.planning.titleCandidates[0] ?? request.brief.topic,
    slug: generateSlug(request.brief.topic),
    description: request.seo.metaDescriptionDraft,
    tags: request.seo.seoKeywords,
    categories: inferCategories(request.brief.topic, request.research),
    canonicalUrlPlaceholder: '{{CANONICAL_URL}}',
    publishDatePlaceholder: '{{PUBLISH_DATE}}',
    readingTimeMinutes,
    readingTimeIsoDuration: `PT${String(readingTimeMinutes)}M`,
    wordCount,
  });
}

function buildSeoArtifact(request: PublishRequest): SeoArtifact {
  const title = request.planning.titleCandidates[0] ?? request.brief.topic;
  const description = request.seo.metaDescriptionDraft;

  return deepFreeze({
    metaTitle: request.seo.seoTitleDraft,
    metaDescription: description,
    openGraph: {
      ogTitle: request.seo.seoTitleDraft,
      ogDescription: description,
      ogType: 'article',
      ogImageAlt: extractHeroAltText(request.draft),
    },
    twitter: {
      twitterCard: 'summary_large_image',
      twitterTitle: request.seo.seoTitleDraft,
      twitterDescription: description,
      twitterImageAlt: extractHeroAltText(request.draft),
    },
    jsonLd: buildJsonLd(request, title, description),
  });
}

function buildAssetsArtifact(request: PublishRequest): AssetsArtifact {
  const imageMarkers = request.draft.current.imageMarkers;
  const heroMarker = imageMarkers.find((marker) => marker.role === 'hero');

  if (heroMarker === undefined) {
    throw new ValidationError(PUBLISHER_MODULE_KEY, [
      'Draft must have exactly one hero image marker.',
    ]);
  }

  const imageManifest: ImageReference[] = imageMarkers.map((marker) => ({
    id: marker.markerId,
    role: marker.role,
    altText: marker.descriptionHint,
  }));

  const altTextManifest = imageMarkers.map((marker) => ({
    imageId: marker.markerId,
    altText: marker.descriptionHint,
  }));

  const captionManifest = imageMarkers
    .filter((marker) => marker.role === 'inline')
    .map((marker) => ({
      imageId: marker.markerId,
      caption: marker.descriptionHint,
    }));

  return deepFreeze({
    featuredImage: {
      id: heroMarker.markerId,
      role: 'hero',
      altText: heroMarker.descriptionHint,
    },
    imageManifest,
    altTextManifest,
    captionManifest,
  });
}

function buildStructuredContentArtifact(request: PublishRequest): StructuredContentArtifact {
  // Extract internal links from link markers
  const internalLinks: InternalLinkReference[] = request.draft.current.linkMarkers.map(
    (marker) => ({
      anchorText: marker.anchorTextHint,
      suggestedTargetTopic: marker.anchorTextHint,
    }),
  );

  // Build FAQ schema from SEO internal link targets
  const faqSchema: FaqSchemaItem[] = request.seo.internalLinkTargets.slice(0, 5).map((target) => ({
    question: `What is ${target.candidateTitle}?`,
    answer: `Learn more about ${target.candidateTitle} in our comprehensive guide.`,
  }));

  // Build related articles from internal link targets
  const relatedArticles: RelatedArticleReference[] = request.seo.internalLinkTargets
    .filter((target) => target.relevance === 'high')
    .map((target) => ({
      suggestedTitle: target.candidateTitle,
      relevanceReason: `High relevance to ${request.brief.topic}`,
    }));

  // Build CTA blocks
  const ctaBlocks: CtaBlock[] = [
    {
      id: 'cta-newsletter',
      headline: 'Stay Updated',
      description: 'Get the latest insights delivered to your inbox.',
      primaryButtonText: 'Subscribe',
    },
  ];

  return deepFreeze({
    faqSchema,
    ctaBlocks,
    relatedArticles,
    internalLinks,
  });
}

function buildValidationArtifact(
  request: PublishRequest,
  _assets: AssetsArtifact,
): ValidationArtifact {
  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];
  const missingAssets: string[] = [];

  // Check for hero image
  const heroMarker = request.draft.current.imageMarkers.find((marker) => marker.role === 'hero');
  if (heroMarker === undefined) {
    errors.push({
      severity: 'error',
      field: 'draft.imageMarkers',
      message: 'Missing hero image marker.',
    });
  }

  // Check for minimum word count
  if (request.draft.current.wordCount < 300) {
    warnings.push({
      severity: 'warning',
      field: 'draft.wordCount',
      message: `Word count (${request.draft.current.wordCount}) is below recommended minimum of 300.`,
    });
  }

  // Check for SEO title length
  if (request.seo.seoTitleDraft.length > 60) {
    warnings.push({
      severity: 'warning',
      field: 'seo.seoTitleDraft',
      message: 'SEO title exceeds 60 characters and may be truncated in search results.',
    });
  }

  // Check for meta description length
  if (request.seo.metaDescriptionDraft.length > 160) {
    warnings.push({
      severity: 'warning',
      field: 'seo.metaDescriptionDraft',
      message: 'Meta description exceeds 160 characters and may be truncated in search results.',
    });
  }

  // Check for review issues
  if (request.review.technical !== undefined && !request.review.technical.passed) {
    const highSeverityIssues = request.review.technical.issues.filter(
      (issue) => issue.severity === 'high',
    );
    if (highSeverityIssues.length > 0) {
      errors.push({
        severity: 'error',
        field: 'review.technical',
        message: `Technical review has ${String(highSeverityIssues.length)} high-severity issues.`,
      });
    }
  }

  // Determine summary
  let summary: 'valid' | 'warnings' | 'errors';
  if (errors.length > 0) {
    summary = 'errors';
  } else if (warnings.length > 0) {
    summary = 'warnings';
  } else {
    summary = 'valid';
  }

  return deepFreeze({
    summary,
    missingAssets: Object.freeze(missingAssets),
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  });
}

function buildChecksumArtifact(markdown: string, buildTimestamp: string): ChecksumArtifact {
  const contentHash = createHash('sha256').update(markdown).digest('hex');

  return deepFreeze({
    contentHash,
    artifactVersion: ARTIFACT_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    buildTimestamp,
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

function markdownToHtml(markdown: string): string {
  // Simple markdown to HTML conversion for basic elements
  let html = markdown;

  // Convert headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');

  // Convert bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Convert italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Convert links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Convert paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>');

  // Wrap in paragraphs
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function markdownToPlainText(markdown: string): string {
  let text = markdown;

  // Remove headers
  text = text.replace(/^#{1,6} (.+)$/gm, '$1');

  // Remove bold/italic markers
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');

  // Remove links, keep text
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // Remove image markers
  text = text.replace(/\[\[image:[^\]]+\]\]/g, '');
  text = text.replace(/\[\[link:[^\]]+\]\]/g, '');

  // Normalize whitespace
  text = text.replace(/\n+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

function generateSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function inferCategories(topic: string, _research: ResearchSection): readonly string[] {
  // Simple category inference from keywords
  const categories: string[] = [];

  const topicLower = topic.toLowerCase();
  if (topicLower.includes('ai') || topicLower.includes('machine learning')) {
    categories.push('Technology');
  }
  if (topicLower.includes('business') || topicLower.includes('marketing')) {
    categories.push('Business');
  }

  // Default category
  if (categories.length === 0) {
    categories.push('General');
  }

  return Object.freeze(categories);
}

function extractHeroAltText(draft: DraftSection): string {
  const heroMarker = draft.current.imageMarkers.find((marker) => marker.role === 'hero');
  return heroMarker?.descriptionHint ?? 'Article hero image';
}

function buildJsonLd(request: PublishRequest, title: string, description: string): string {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    author: {
      '@type': 'Organization',
      name: 'Blogspage',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Blogspage',
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
    },
  };

  return JSON.stringify(jsonLd);
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
