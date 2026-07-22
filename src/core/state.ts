/**
 * PipelineState types and initialization.
 *
 * This is the single data contract for the entire pipeline. Every module
 * receives PipelineState, reads the keys it needs, and writes to exactly
 * one section (its own namespaced output).
 *
 * @see architecture/04-json-contracts.md - Full schema specification
 */

import { randomUUID } from 'node:crypto';
import { isoNow } from '@/lib/dates.js';

// ============================================================================
// Metadata Section
// ============================================================================

export interface Metadata {
  /** UUID generated at run start. */
  readonly runId: string;
  /** ISO 8601 timestamp when the run started. */
  readonly startedAt: string;
  /** The sheet row ID being processed. */
  sheetRowId: string;
  /** Current run status. */
  status: 'running' | 'published' | 'needs_review' | 'failed';
  /** Reserved for multi-tenancy (absent in v1). */
  readonly tenantId?: string;
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
  readonly targetAudience?: string;
  /** SEO keyword hints. */
  readonly keywordHints?: readonly string[];
  /** Optional constraints or requirements. */
  readonly constraints?: readonly string[];
  /** The sheet row ID this brief came from. */
  readonly sheetRowId: string;
}

// ============================================================================
// Research Section
// ============================================================================

export interface ResearchSection {
  readonly keyFacts: readonly string[];
  readonly suggestedAngle: string;
  readonly competitorGapNotes?: readonly string[];
  readonly candidateStatistics: readonly {
    readonly claim: string;
    readonly informalSource?: string;
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

export interface DraftHistoryEntry {
  /** The module that produced this draft version. */
  readonly producedBy: string;
  /** When this version was created. */
  readonly at: string;
  /** The draft content. */
  readonly draft: Draft;
}

export interface DraftSection {
  /** The current draft version. */
  current: Draft;
  /** History of all draft versions. */
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
  readonly suggestedFix?: string;
}

export interface ReviewOutput {
  readonly passed: boolean;
  readonly issues: readonly ReviewIssue[];
  /** SEO Reviewer only: revised title suggestion. */
  readonly revisedSeoTitle?: string;
  /** SEO Reviewer only: revised meta description suggestion. */
  readonly revisedMetaDescription?: string;
}

export interface ReviewSection {
  readonly technical?: ReviewOutput;
  readonly seo?: ReviewOutput;
  /** Loop counter owned by the orchestrator. */
  readonly loop: {
    iteration: number;
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
  readonly placementMarkerId?: string;
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
    readonly costUsd?: number;
  };
}

export interface ImageValidationResult {
  readonly imageId: string;
  readonly passed: boolean;
  readonly reason?: string;
  readonly retriesUsed: number;
}

export interface UploadedImage {
  readonly imageId: string;
  readonly role: 'hero' | 'inline';
  readonly assetId: string;
  readonly altText: string;
  readonly placementMarkerId?: string;
}

export interface ImagesSection {
  readonly plan?: ImagePlan;
  readonly generated?: readonly GeneratedImage[];
  readonly validation?: readonly ImageValidationResult[];
  readonly uploaded?: readonly UploadedImage[];
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
  [key: string]: unknown;
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
  readonly mainImage?: {
    readonly _type: 'image';
    readonly alt: string;
    readonly asset: { readonly _type: 'reference'; readonly _ref: string };
    readonly caption?: string;
  };
  readonly content: readonly PortableTextBlock[];
  readonly faq?: readonly FaqItem[];
  readonly focusKeyword?: string;
  readonly seoKeywords?: readonly string[];
  readonly seoTitle?: string;
  readonly metaDescription?: string;
  readonly featured?: boolean;
  readonly evergreen?: boolean;
  [key: string]: unknown;
}

export interface SanitySection {
  readonly resolvedLinks?: readonly ResolvedLink[];
  readonly portableText?: readonly PortableTextBlock[];
  readonly faq?: readonly FaqItem[];
  readonly structuredDataCheck?: StructuredDataCheck;
  readonly document?: SanityPostDocument;
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
  readonly module: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly cached: boolean;
  readonly timestamp: string;
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
  brief?: Brief;
  research?: ResearchSection;
  planning?: PlanningSection;
  seo?: SeoSection;
  draft?: DraftSection;
  review?: ReviewSection;
  qa?: QaSection;
  images?: ImagesSection;
  sanity?: SanitySection;
  publishing?: PublishingSection;
  readonly metrics: MetricsSection;
  readonly errors: readonly ErrorRecord[];
  readonly timings: readonly TimingRecord[];
}

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

/**
 * Creates the initial PipelineState for a new run.
 *
 * @param options - Optional configuration for the initial state.
 * @returns A fresh PipelineState ready for the pipeline.
 */
export function createInitialState(options?: InitialStateOptions): PipelineState {
  const runId = randomUUID();
  const startedAt = isoNow();

  return {
    metadata: {
      runId,
      startedAt,
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

/**
 * Creates a PipelineState from a topic brief (for testing/playground).
 *
 * @param brief - The topic brief.
 * @returns A PipelineState with the brief already set.
 */
export function createStateFromBrief(brief: Brief): PipelineState {
  const state = createInitialState({ sheetRowId: brief.sheetRowId });
  return {
    ...state,
    brief,
  };
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
