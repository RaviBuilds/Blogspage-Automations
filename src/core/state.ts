/**
 * PipelineState contract, validation, ownership, and immutable state updates.
 *
 * This is the single data contract for the entire pipeline. Every module reads
 * the sections it needs and writes only its documented owned paths.
 *
 * @see architecture/04-json-contracts.md - Full schema and ownership specification
 * @see architecture/09-provider-abstraction.md - Provider result vocabulary
 * @see architecture/15-cost-tracking-system.md - Cost event contract
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModuleKey, ProviderName } from '@/core/types.js';
import { isIsoTimestamp, isoNow } from '@/lib/dates.js';

export type PipelineStatus = 'running' | 'published' | 'needs_review' | 'failed';

// ============================================================================
// Metadata Section
// ============================================================================

export interface Metadata {
  /** UUID generated at run start. */
  readonly runId: string;
  /** ISO 8601 timestamp when the run started. */
  readonly startedAt: string;
  /** The sheet row ID being processed. */
  readonly sheetRowId: string;
  /** Current run status. */
  readonly status: PipelineStatus;
  /** Reserved for multi-tenancy (absent in v1). */
  readonly tenantId?: string | undefined;
  /** Locale for prompts (default: 'en'). */
  readonly locale: string;
  /** Target site identifier (default: 'blogspage'). */
  readonly targetSite: string;
}

// ============================================================================
// Brief Section (Sheet Reader)
// ============================================================================

export interface Brief {
  /** The main topic/title for the article. */
  readonly topic: string;
  /** Target audience for the article. */
  readonly targetAudience?: string | undefined;
  /** SEO keyword hints. */
  readonly keywordHints?: readonly string[] | undefined;
  /** Optional constraints or requirements. */
  readonly constraints?: readonly string[] | undefined;
  /** The sheet row ID this brief came from. */
  readonly sheetRowId: string;
}

// ============================================================================
// Research Section
// ============================================================================

export interface ResearchSection {
  readonly keyFacts: readonly string[];
  readonly suggestedAngle: string;
  readonly competitorGapNotes?: readonly string[] | undefined;
  readonly candidateStatistics: readonly {
    readonly claim: string;
    readonly informalSource?: string | undefined;
  }[];
}

// ============================================================================
// Planning Section
// ============================================================================

export interface PlanningSection {
  readonly titleCandidates: readonly string[];
  readonly outline: readonly {
    readonly heading: string;
    readonly level: 2 | 3;
    readonly talkingPoints: readonly string[];
  }[];
  readonly targetWordCount: number;
  readonly angle: string;
}

// ============================================================================
// SEO Section
// ============================================================================

export interface SeoSection {
  readonly focusKeyword: string;
  readonly seoKeywords: readonly string[];
  readonly seoTitleDraft: string;
  readonly metaDescriptionDraft: string;
  readonly internalLinkTargets: readonly {
    readonly candidateSlug: string;
    readonly candidateTitle: string;
    readonly relevance: 'high' | 'medium';
  }[];
}

// ============================================================================
// Draft Section
// ============================================================================

export interface Draft {
  /** The Markdown content of the draft. */
  readonly markdown: string;
  /** Word count of the draft. */
  readonly wordCount: number;
  /** Internal link markers in the draft. */
  readonly linkMarkers: readonly {
    readonly markerId: string;
    readonly anchorTextHint: string;
  }[];
  /** Image markers in the draft. */
  readonly imageMarkers: readonly {
    readonly markerId: string;
    readonly role: 'hero' | 'inline';
    readonly descriptionHint: string;
  }[];
}

export type DraftWriterKey = 'writer' | 'humanizer' | 'improver';

export interface DraftHistoryEntry {
  /** The module that produced the succeeding draft version. */
  readonly producedBy: DraftWriterKey;
  /** When the succeeding draft version was created. */
  readonly at: string;
  /** The previous draft content. */
  readonly draft: Draft;
}

export interface DraftSection {
  /** The current draft version. */
  readonly current: Draft;
  /** Ordered history of all superseded draft versions. */
  readonly history: readonly DraftHistoryEntry[];
}

// ============================================================================
// Review Section
// ============================================================================

export interface ReviewIssue {
  readonly id: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly location: string;
  readonly description: string;
  readonly suggestedFix?: string | undefined;
}

export interface ReviewOutput {
  readonly passed: boolean;
  readonly issues: readonly ReviewIssue[];
  /** SEO Reviewer only: revised title suggestion. */
  readonly revisedSeoTitle?: string | undefined;
  /** SEO Reviewer only: revised meta description suggestion. */
  readonly revisedMetaDescription?: string | undefined;
}

export interface ReviewSection {
  readonly technical?: ReviewOutput | undefined;
  readonly seo?: ReviewOutput | undefined;
  /** Loop counter owned by the orchestrator. */
  readonly loop: {
    readonly iteration: number;
  };
}

// ============================================================================
// QA Section
// ============================================================================

export interface QaSection {
  readonly decision: 'pass' | 'needsRevision' | 'failClosed';
  readonly remainingIssues: readonly ReviewIssue[];
}

// ============================================================================
// Images Section
// ============================================================================

export interface ImagePlanItem {
  readonly id: string;
  readonly role: 'hero' | 'inline';
  readonly prompt: string;
  readonly altTextDraft: string;
  readonly aspectRatio: string;
  readonly placementMarkerId?: string | undefined;
}

export interface ImagePlan {
  readonly images: readonly ImagePlanItem[];
}

export interface GeneratedImage {
  readonly imageId: string;
  readonly role: 'hero' | 'inline';
  readonly data: {
    readonly type: 'buffer' | 'url';
    readonly value: string;
  };
  readonly contentType: string;
  readonly generationMeta: {
    readonly provider: string;
    readonly model: string;
    readonly costUsd?: number | undefined;
  };
}

export interface ImageValidationResult {
  readonly imageId: string;
  readonly passed: boolean;
  readonly reason?: string | undefined;
  readonly retriesUsed: number;
}

export interface UploadedImage {
  readonly imageId: string;
  readonly role: 'hero' | 'inline';
  readonly assetId: string;
  readonly altText: string;
  readonly placementMarkerId?: string | undefined;
}

export interface ImagesSection {
  readonly plan?: ImagePlan | undefined;
  readonly generated?: readonly GeneratedImage[] | undefined;
  readonly validation?: readonly ImageValidationResult[] | undefined;
  readonly uploaded?: readonly UploadedImage[] | undefined;
}

// ============================================================================
// Sanity Section
// ============================================================================

export interface ResolvedLink {
  readonly markerId: string;
  readonly targetPostId: string;
  readonly targetSlug: string;
  readonly anchorText: string;
}

export interface PortableTextBlock {
  readonly _type: string;
  readonly _key: string;
  readonly [key: string]: unknown;
}

export interface FaqItem {
  readonly _type: 'faqItem';
  readonly _key: string;
  readonly question: string;
  readonly answer: string;
}

export interface StructuredDataCheck {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly autoFilled: readonly string[];
}

export interface SanityPostDocument {
  readonly _type: 'post';
  readonly title: string;
  readonly slug: { readonly _type: 'slug'; readonly current: string };
  readonly excerpt: string;
  readonly author: { readonly _type: 'reference'; readonly _ref: string };
  readonly publishedAt: string;
  readonly categories: readonly {
    readonly _type: 'reference';
    readonly _ref: string;
    readonly _key: string;
  }[];
  readonly mainImage?:
    | {
        readonly _type: 'image';
        readonly alt: string;
        readonly asset: { readonly _type: 'reference'; readonly _ref: string };
        readonly caption?: string | undefined;
      }
    | undefined;
  readonly content: readonly PortableTextBlock[];
  readonly faq?: readonly FaqItem[] | undefined;
  readonly focusKeyword?: string | undefined;
  readonly seoKeywords?: readonly string[] | undefined;
  readonly seoTitle?: string | undefined;
  readonly metaDescription?: string | undefined;
  readonly featured?: boolean | undefined;
  readonly evergreen?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface SanitySection {
  readonly resolvedLinks?: readonly ResolvedLink[] | undefined;
  readonly portableText?: readonly PortableTextBlock[] | undefined;
  readonly faq?: readonly FaqItem[] | undefined;
  readonly structuredDataCheck?: StructuredDataCheck | undefined;
  readonly document?: SanityPostDocument | undefined;
}

// ============================================================================
// Publishing Section
// ============================================================================

export interface PublishingSection {
  readonly documentId: string;
  readonly publishedAt: string;
  readonly sheetRowUpdated: boolean;
  readonly liveUrlEstimate: string;
}

// ============================================================================
// Metrics Section
// ============================================================================

export interface CostEvent {
  readonly runId: string;
  readonly moduleKey: ModuleKey;
  readonly attemptNumber: number;
  readonly timestamp: string;
  readonly provider: ProviderName;
  readonly modelId: string;
  readonly promptVersion?: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  readonly pricingVerifiedAt: string;
  readonly latencyMs: number;
  readonly outcome: 'success' | 'providerError' | 'validationError' | 'timeout';
  readonly isImageGeneration: boolean;
}

export interface MetricsSection {
  readonly costEvents: readonly CostEvent[];
  readonly totalCostUsd: number;
}

// ============================================================================
// Error and Timing Records
// ============================================================================

export interface ErrorRecord {
  readonly runId: string;
  readonly module: string;
  readonly errorClass: 'ValidationError' | 'ProviderError' | 'RetryableError' | 'FatalError';
  readonly attemptNumber: number;
  readonly message: string;
  readonly timestamp: string;
  readonly resolved: boolean;
}

export interface TimingRecord {
  readonly runId: string;
  readonly module: string;
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly durationMs: number;
}

// ============================================================================
// Complete PipelineState
// ============================================================================

export interface PipelineState {
  readonly metadata: Metadata;
  readonly brief?: Brief | undefined;
  readonly research?: ResearchSection | undefined;
  readonly planning?: PlanningSection | undefined;
  readonly seo?: SeoSection | undefined;
  readonly draft?: DraftSection | undefined;
  readonly review?: ReviewSection | undefined;
  readonly qa?: QaSection | undefined;
  readonly images?: ImagesSection | undefined;
  readonly sanity?: SanitySection | undefined;
  readonly publishing?: PublishingSection | undefined;
  readonly metrics: MetricsSection;
  readonly errors: readonly ErrorRecord[];
  readonly timings: readonly TimingRecord[];
}

// ============================================================================
// Runtime Validation
// ============================================================================

const IsoTimestampSchema = z.string().refine(isIsoTimestamp, {
  message: 'Expected a canonical UTC ISO 8601 timestamp.',
});

const IsoDateSchema = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  },
  { message: 'Expected a real ISO calendar date (YYYY-MM-DD).' },
);

const ModuleKeySchema = z.enum([
  'sheet-reader',
  'research',
  'planner',
  'seo-planner',
  'writer',
  'reviewer-technical',
  'reviewer-seo',
  'humanizer',
  'qa',
  'improver',
  'image-planner',
  'image-generator',
  'image-validator',
  'portable-text',
  'internal-links',
  'faq-generator',
  'structured-data-check',
  'image-upload',
  'sanity-builder',
  'publish',
  'notify',
]);

const ProviderNameSchema = z.enum(['anthropic', 'openai', 'gemini', 'openrouter', 'local']);

export const MetadataSchema = z
  .object({
    runId: z.string(),
    startedAt: IsoTimestampSchema,
    sheetRowId: z.string(),
    status: z.enum(['running', 'published', 'needs_review', 'failed']),
    tenantId: z.string().optional(),
    locale: z.string(),
    targetSite: z.string(),
  })
  .strict();

export const BriefSchema = z
  .object({
    topic: z.string(),
    targetAudience: z.string().optional(),
    keywordHints: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    sheetRowId: z.string(),
  })
  .strict();

const CandidateStatisticSchema = z
  .object({
    claim: z.string(),
    informalSource: z.string().optional(),
  })
  .strict();

export const ResearchSectionSchema = z
  .object({
    keyFacts: z.array(z.string()),
    suggestedAngle: z.string(),
    competitorGapNotes: z.array(z.string()).optional(),
    candidateStatistics: z.array(CandidateStatisticSchema),
  })
  .strict();

const OutlineItemSchema = z
  .object({
    heading: z.string(),
    level: z.union([z.literal(2), z.literal(3)]),
    talkingPoints: z.array(z.string()),
  })
  .strict();

export const PlanningSectionSchema = z
  .object({
    titleCandidates: z.array(z.string()),
    outline: z.array(OutlineItemSchema),
    targetWordCount: z.number(),
    angle: z.string(),
  })
  .strict();

const InternalLinkTargetSchema = z
  .object({
    candidateSlug: z.string(),
    candidateTitle: z.string(),
    relevance: z.enum(['high', 'medium']),
  })
  .strict();

export const SeoSectionSchema = z
  .object({
    focusKeyword: z.string(),
    seoKeywords: z.array(z.string()),
    seoTitleDraft: z.string(),
    metaDescriptionDraft: z.string(),
    internalLinkTargets: z.array(InternalLinkTargetSchema),
  })
  .strict();

const LinkMarkerSchema = z
  .object({
    markerId: z.string(),
    anchorTextHint: z.string(),
  })
  .strict();

const ImageMarkerSchema = z
  .object({
    markerId: z.string(),
    role: z.enum(['hero', 'inline']),
    descriptionHint: z.string(),
  })
  .strict();

export const DraftSchema = z
  .object({
    markdown: z.string(),
    wordCount: z.number(),
    linkMarkers: z.array(LinkMarkerSchema),
    imageMarkers: z.array(ImageMarkerSchema),
  })
  .strict();

export const DraftHistoryEntrySchema = z
  .object({
    producedBy: z.enum(['writer', 'humanizer', 'improver']),
    at: IsoTimestampSchema,
    draft: DraftSchema,
  })
  .strict();

export const DraftSectionSchema = z
  .object({
    current: DraftSchema,
    history: z.array(DraftHistoryEntrySchema),
  })
  .strict();

export const ReviewIssueSchema = z
  .object({
    id: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    location: z.string(),
    description: z.string(),
    suggestedFix: z.string().optional(),
  })
  .strict();

export const ReviewOutputSchema = z
  .object({
    passed: z.boolean(),
    issues: z.array(ReviewIssueSchema),
    revisedSeoTitle: z.string().optional(),
    revisedMetaDescription: z.string().optional(),
  })
  .strict();

export const ReviewSectionSchema = z
  .object({
    technical: ReviewOutputSchema.optional(),
    seo: ReviewOutputSchema.optional(),
    loop: z
      .object({
        iteration: z.number(),
      })
      .strict(),
  })
  .strict();

export const QaSectionSchema = z
  .object({
    decision: z.enum(['pass', 'needsRevision', 'failClosed']),
    remainingIssues: z.array(ReviewIssueSchema),
  })
  .strict();

export const ImagePlanItemSchema = z
  .object({
    id: z.string(),
    role: z.enum(['hero', 'inline']),
    prompt: z.string(),
    altTextDraft: z.string(),
    aspectRatio: z.string(),
    placementMarkerId: z.string().optional(),
  })
  .strict();

export const ImagePlanSchema = z
  .object({
    images: z.array(ImagePlanItemSchema),
  })
  .strict();

export const GeneratedImageSchema = z
  .object({
    imageId: z.string(),
    role: z.enum(['hero', 'inline']),
    data: z
      .object({
        type: z.enum(['buffer', 'url']),
        value: z.string(),
      })
      .strict(),
    contentType: z.string(),
    generationMeta: z
      .object({
        provider: z.string(),
        model: z.string(),
        costUsd: z.number().optional(),
      })
      .strict(),
  })
  .strict();

export const ImageValidationResultSchema = z
  .object({
    imageId: z.string(),
    passed: z.boolean(),
    reason: z.string().optional(),
    retriesUsed: z.number(),
  })
  .strict();

export const UploadedImageSchema = z
  .object({
    imageId: z.string(),
    role: z.enum(['hero', 'inline']),
    assetId: z.string(),
    altText: z.string(),
    placementMarkerId: z.string().optional(),
  })
  .strict();

export const ImagesSectionSchema = z
  .object({
    plan: ImagePlanSchema.optional(),
    generated: z.array(GeneratedImageSchema).optional(),
    validation: z.array(ImageValidationResultSchema).optional(),
    uploaded: z.array(UploadedImageSchema).optional(),
  })
  .strict();

export const ResolvedLinkSchema = z
  .object({
    markerId: z.string(),
    targetPostId: z.string(),
    targetSlug: z.string(),
    anchorText: z.string(),
  })
  .strict();

export const PortableTextBlockSchema = z
  .object({
    _type: z.string(),
    _key: z.string(),
  })
  .passthrough();

export const FaqItemSchema = z
  .object({
    _type: z.literal('faqItem'),
    _key: z.string(),
    question: z.string(),
    answer: z.string(),
  })
  .strict();

export const StructuredDataCheckSchema = z
  .object({
    ready: z.boolean(),
    missing: z.array(z.string()),
    autoFilled: z.array(z.string()),
  })
  .strict();

const ReferenceSchema = z
  .object({
    _type: z.literal('reference'),
    _ref: z.string(),
  })
  .strict();

const SanityCategoryReferenceSchema = ReferenceSchema.extend({
  _key: z.string(),
}).strict();

const SanityImageSchema = z
  .object({
    _type: z.literal('image'),
    alt: z.string(),
    asset: ReferenceSchema,
    caption: z.string().optional(),
  })
  .strict();

export const SanityPostDocumentSchema = z
  .object({
    _type: z.literal('post'),
    title: z.string(),
    slug: z
      .object({
        _type: z.literal('slug'),
        current: z.string(),
      })
      .strict(),
    excerpt: z.string(),
    author: ReferenceSchema,
    publishedAt: z.string(),
    categories: z.array(SanityCategoryReferenceSchema),
    mainImage: SanityImageSchema.optional(),
    content: z.array(PortableTextBlockSchema),
    faq: z.array(FaqItemSchema).optional(),
    focusKeyword: z.string().optional(),
    seoKeywords: z.array(z.string()).optional(),
    seoTitle: z.string().optional(),
    metaDescription: z.string().optional(),
    featured: z.boolean().optional(),
    evergreen: z.boolean().optional(),
  })
  .passthrough();

export const SanitySectionSchema = z
  .object({
    resolvedLinks: z.array(ResolvedLinkSchema).optional(),
    portableText: z.array(PortableTextBlockSchema).optional(),
    faq: z.array(FaqItemSchema).optional(),
    structuredDataCheck: StructuredDataCheckSchema.optional(),
    document: SanityPostDocumentSchema.optional(),
  })
  .strict();

export const PublishingSectionSchema = z
  .object({
    documentId: z.string(),
    publishedAt: IsoTimestampSchema,
    sheetRowUpdated: z.boolean(),
    liveUrlEstimate: z.string(),
  })
  .strict();

export const CostEventSchema = z
  .object({
    runId: z.string(),
    moduleKey: ModuleKeySchema,
    attemptNumber: z.number(),
    timestamp: IsoTimestampSchema,
    provider: ProviderNameSchema,
    modelId: z.string(),
    promptVersion: z.string().optional(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number(),
    reasoningTokens: z.number(),
    estimatedCostUsd: z.number(),
    pricingVerifiedAt: IsoDateSchema,
    latencyMs: z.number(),
    outcome: z.enum(['success', 'providerError', 'validationError', 'timeout']),
    isImageGeneration: z.boolean(),
  })
  .strict();

export const MetricsSectionSchema = z
  .object({
    costEvents: z.array(CostEventSchema),
    totalCostUsd: z.number(),
  })
  .strict();

export const ErrorRecordSchema = z
  .object({
    runId: z.string(),
    module: z.string(),
    errorClass: z.enum(['ValidationError', 'ProviderError', 'RetryableError', 'FatalError']),
    attemptNumber: z.number(),
    message: z.string(),
    timestamp: IsoTimestampSchema,
    resolved: z.boolean(),
  })
  .strict();

export const TimingRecordSchema = z
  .object({
    runId: z.string(),
    module: z.string(),
    attemptNumber: z.number(),
    startedAt: IsoTimestampSchema,
    durationMs: z.number(),
  })
  .strict();

const PipelineStateRuntimeSchema = z
  .object({
    metadata: MetadataSchema,
    brief: BriefSchema.optional(),
    research: ResearchSectionSchema.optional(),
    planning: PlanningSectionSchema.optional(),
    seo: SeoSectionSchema.optional(),
    draft: DraftSectionSchema.optional(),
    review: ReviewSectionSchema.optional(),
    qa: QaSectionSchema.optional(),
    images: ImagesSectionSchema.optional(),
    sanity: SanitySectionSchema.optional(),
    publishing: PublishingSectionSchema.optional(),
    metrics: MetricsSectionSchema,
    errors: z.array(ErrorRecordSchema),
    timings: z.array(TimingRecordSchema),
  })
  .strict();

/** Runtime validator for the persisted PipelineState contract. */
export const PipelineStateSchema: z.ZodType<PipelineState> = PipelineStateRuntimeSchema;

// ============================================================================
// State Ownership
// ============================================================================

export type StateWritePath =
  | 'metadata.runId'
  | 'metadata.startedAt'
  | 'metadata.sheetRowId'
  | 'metadata.status'
  | 'metadata.locale'
  | 'metadata.targetSite'
  | 'brief'
  | 'research'
  | 'planning'
  | 'seo'
  | 'draft.current'
  | 'draft.history'
  | 'review.technical'
  | 'review.seo'
  | 'review.loop.iteration'
  | 'qa'
  | 'images.plan'
  | 'images.generated'
  | 'images.validation'
  | 'images.uploaded'
  | 'sanity.resolvedLinks'
  | 'sanity.portableText'
  | 'sanity.faq'
  | 'sanity.structuredDataCheck'
  | 'sanity.document'
  | 'publishing'
  | 'metrics.costEvents'
  | 'metrics.totalCostUsd'
  | 'errors'
  | 'timings';

export type StateWriter = ModuleKey | 'orchestrator' | 'moduleRunner';

/** The frozen ownership table encoded as a compile-time checked state map. */
export const STATE_FIELD_OWNERS = Object.freeze({
  'metadata.runId': ['orchestrator'],
  'metadata.startedAt': ['orchestrator'],
  'metadata.sheetRowId': ['sheet-reader'],
  'metadata.status': ['orchestrator'],
  'metadata.locale': ['orchestrator'],
  'metadata.targetSite': ['orchestrator'],
  brief: ['sheet-reader'],
  research: ['research'],
  planning: ['planner'],
  seo: ['seo-planner'],
  'draft.current': ['writer', 'humanizer', 'improver'],
  'draft.history': ['writer', 'humanizer', 'improver'],
  'review.technical': ['reviewer-technical'],
  'review.seo': ['reviewer-seo'],
  'review.loop.iteration': ['orchestrator'],
  qa: ['qa'],
  'images.plan': ['image-planner'],
  'images.generated': ['image-generator'],
  'images.validation': ['image-validator'],
  'images.uploaded': ['image-upload'],
  'sanity.resolvedLinks': ['internal-links'],
  'sanity.portableText': ['portable-text'],
  'sanity.faq': ['faq-generator'],
  'sanity.structuredDataCheck': ['structured-data-check'],
  'sanity.document': ['sanity-builder'],
  publishing: ['publish'],
  'metrics.costEvents': ['moduleRunner'],
  'metrics.totalCostUsd': ['moduleRunner'],
  errors: ['moduleRunner'],
  timings: ['moduleRunner'],
} as const satisfies Record<StateWritePath, readonly StateWriter[]>);

// ============================================================================
// Initialization
// ============================================================================

export interface InitialStateOptions {
  /** Optional sheet row ID (set by Sheet Reader). */
  readonly sheetRowId?: string;
  /** Optional locale override (default: 'en'). */
  readonly locale?: string;
  /** Optional target site override (default: 'blogspage'). */
  readonly targetSite?: string;
}

/** Creates the initial PipelineState for a new run. */
export function createInitialState(options?: InitialStateOptions): PipelineState {
  return {
    metadata: {
      runId: randomUUID(),
      startedAt: isoNow(),
      sheetRowId: options?.sheetRowId ?? '',
      status: 'running',
      locale: options?.locale ?? 'en',
      targetSite: options?.targetSite ?? 'blogspage',
    },
    metrics: {
      costEvents: [],
      totalCostUsd: 0,
    },
    errors: [],
    timings: [],
  };
}

/** Creates a PipelineState from a topic brief (for testing/playground). */
export function createStateFromBrief(brief: Brief): PipelineState {
  const state = createInitialState({ sheetRowId: brief.sheetRowId });
  return {
    ...state,
    brief,
  };
}

// ============================================================================
// Immutable Updates
// ============================================================================

function assertCanonicalTimestamp(value: string, field: string): void {
  if (!isIsoTimestamp(value)) {
    throw new RangeError(`${field} must be a canonical UTC ISO 8601 timestamp.`);
  }
}

function assertRecordRunId(state: PipelineState, runId: string, recordName: string): void {
  if (runId !== state.metadata.runId) {
    throw new RangeError(`${recordName}.runId must match state.metadata.runId.`);
  }
}

/** Returns state with the Sheet Reader-owned row ID assigned. */
export function setSheetRowId(state: PipelineState, sheetRowId: string): PipelineState {
  return {
    ...state,
    metadata: {
      ...state.metadata,
      sheetRowId,
    },
  };
}

/** Returns state with an orchestrator-owned lifecycle status transition. */
export function setPipelineStatus(state: PipelineState, status: PipelineStatus): PipelineState {
  return {
    ...state,
    metadata: {
      ...state.metadata,
      status,
    },
  };
}

/** Returns state with the orchestrator-owned review-loop iteration. */
export function setReviewLoopIteration(state: PipelineState, iteration: number): PipelineState {
  return {
    ...state,
    review: {
      ...state.review,
      loop: { iteration },
    },
  };
}

/**
 * Replaces the current draft without mutating state. Every replacement after
 * the initial write appends the former current draft to ordered history.
 */
export function replaceDraft(
  state: PipelineState,
  producedBy: DraftWriterKey,
  nextDraft: Draft,
  at: string = isoNow(),
): PipelineState {
  assertCanonicalTimestamp(at, 'at');

  if (state.draft === undefined) {
    return {
      ...state,
      draft: {
        current: nextDraft,
        history: [],
      },
    };
  }

  return {
    ...state,
    draft: {
      current: nextDraft,
      history: [
        ...state.draft.history,
        {
          producedBy,
          at,
          draft: state.draft.current,
        },
      ],
    },
  };
}

/** Appends one cost event and recomputes the rolling total from the full log. */
export function appendCostEvent(state: PipelineState, event: CostEvent): PipelineState {
  assertRecordRunId(state, event.runId, 'event');
  const costEvents = [...state.metrics.costEvents, event];

  return {
    ...state,
    metrics: {
      costEvents,
      totalCostUsd: costEvents.reduce((total, costEvent) => total + costEvent.estimatedCostUsd, 0),
    },
  };
}

/** Appends an immutable structured error record. */
export function appendErrorRecord(state: PipelineState, record: ErrorRecord): PipelineState {
  assertRecordRunId(state, record.runId, 'record');
  return {
    ...state,
    errors: [...state.errors, record],
  };
}

/** Appends an immutable timing record. */
export function appendTimingRecord(state: PipelineState, record: TimingRecord): PipelineState {
  assertRecordRunId(state, record.runId, 'record');
  return {
    ...state,
    timings: [...state.timings, record],
  };
}

// ============================================================================
// Legacy Flat-State Migration
// ============================================================================

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function migrateTopLevelAlias(state: UnknownRecord, legacyKey: string, newKey: string): void {
  if (!hasOwn(state, legacyKey)) {
    return;
  }

  if (hasOwn(state, newKey)) {
    throw new RangeError(`Legacy state field "${legacyKey}" conflicts with "${newKey}".`);
  }

  state[newKey] = state[legacyKey];
  delete state[legacyKey];
}

function migrateNestedAlias(
  state: UnknownRecord,
  legacyKey: string,
  sectionKey: string,
  fieldKey: string,
): void {
  if (!hasOwn(state, legacyKey)) {
    return;
  }

  const existingSection = state[sectionKey];
  if (existingSection !== undefined && !isRecord(existingSection)) {
    throw new RangeError(
      `State section "${sectionKey}" must be an object to migrate "${legacyKey}".`,
    );
  }

  const section = existingSection === undefined ? {} : { ...existingSection };
  if (hasOwn(section, fieldKey)) {
    throw new RangeError(
      `Legacy state field "${legacyKey}" conflicts with "${sectionKey}.${fieldKey}".`,
    );
  }

  section[fieldKey] = state[legacyKey];
  state[sectionKey] = section;
  delete state[legacyKey];
}

function migrateLegacyDraft(state: UnknownRecord): void {
  if (!hasOwn(state, 'draft') || !isRecord(state.draft)) {
    return;
  }

  if (hasOwn(state.draft, 'current') || hasOwn(state.draft, 'history')) {
    return;
  }

  state.draft = {
    current: state.draft,
    history: [],
  };
}

/**
 * Converts only the documented pre-nested flat keys to the frozen nested shape.
 * The returned value remains unknown until PipelineStateSchema validates it.
 */
export function migrateLegacyPipelineState(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const state = { ...value };
  migrateTopLevelAlias(state, 'contentPlan', 'planning');
  migrateTopLevelAlias(state, 'seoPlan', 'seo');
  migrateLegacyDraft(state);
  migrateNestedAlias(state, 'technicalReview', 'review', 'technical');
  migrateNestedAlias(state, 'seoReview', 'review', 'seo');
  migrateNestedAlias(state, 'reviewLoop', 'review', 'loop');
  migrateTopLevelAlias(state, 'qaGate', 'qa');
  migrateNestedAlias(state, 'imagePlan', 'images', 'plan');
  migrateNestedAlias(state, 'generatedImages', 'images', 'generated');
  migrateNestedAlias(state, 'imageValidation', 'images', 'validation');
  migrateNestedAlias(state, 'uploadedImages', 'images', 'uploaded');
  migrateNestedAlias(state, 'resolvedLinks', 'sanity', 'resolvedLinks');
  migrateNestedAlias(state, 'portableText', 'sanity', 'portableText');
  migrateNestedAlias(state, 'faq', 'sanity', 'faq');
  migrateNestedAlias(state, 'structuredDataCheck', 'sanity', 'structuredDataCheck');
  migrateNestedAlias(state, 'sanityDocument', 'sanity', 'document');
  migrateTopLevelAlias(state, 'publishResult', 'publishing');

  return state;
}

// ============================================================================
// Type Guards
// ============================================================================

export function hasBrief(state: PipelineState): state is PipelineState & { brief: Brief } {
  return state.brief !== undefined;
}

export function hasResearch(
  state: PipelineState,
): state is PipelineState & { research: ResearchSection } {
  return state.research !== undefined;
}

export function hasPlanning(
  state: PipelineState,
): state is PipelineState & { planning: PlanningSection } {
  return state.planning !== undefined;
}

export function hasSeo(state: PipelineState): state is PipelineState & { seo: SeoSection } {
  return state.seo !== undefined;
}

export function hasDraft(state: PipelineState): state is PipelineState & { draft: DraftSection } {
  return state.draft !== undefined;
}

export function hasImages(
  state: PipelineState,
): state is PipelineState & { images: ImagesSection } {
  return state.images !== undefined;
}

export function hasSanityDocument(state: PipelineState): state is PipelineState & {
  sanity: SanitySection & { document: SanityPostDocument };
} {
  return state.sanity?.document !== undefined;
}

export function isRunning(state: PipelineState): boolean {
  return state.metadata.status === 'running';
}

export function isPublished(state: PipelineState): boolean {
  return state.metadata.status === 'published';
}

export function needsReview(state: PipelineState): boolean {
  return state.metadata.status === 'needs_review';
}

export function isFailed(state: PipelineState): boolean {
  return state.metadata.status === 'failed';
}
