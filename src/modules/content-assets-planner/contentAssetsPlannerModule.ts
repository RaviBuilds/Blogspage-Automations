/**
 * Provider-agnostic Content Assets Planner module.
 *
 * The module generates a complete asset blueprint that downstream publishers
 * or image-generation providers can consume. It does NOT generate media.
 * Instead, it produces specifications and prompts for all content assets.
 * Provider invocation, timing, cost-event persistence, scheduling, and
 * checkpointing remain owned by ModuleRunner and PipelineOrchestrator.
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
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const CONTENT_ASSETS_PLANNER_MODULE_KEY = 'content-assets-planner' as const;
const MAX_OUTPUT_TOKENS = 12_000;
const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

// ============================================================================
// Input Contract
// ============================================================================

/**
 * Stable, persisted inputs available to the Content Assets Planner through
 * PipelineState. The module requires brief, research, planning, SEO, draft,
 * and review sections to understand the full context and generate comprehensive
 * asset specifications.
 */
export interface AssetsRequest {
  readonly brief: Brief;
  readonly research: ResearchSection;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
  readonly draft: DraftSection;
  readonly review: ReviewSection;
}

export const AssetsRequestSchema: z.ZodType<AssetsRequest> = z
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
// Output Contract - Rich Assets Result
// ============================================================================

/** Specification for a single image asset. */
export interface ImageSpecification {
  readonly id: string;
  readonly type: 'featured' | 'opengraph' | 'twitter' | 'section';
  readonly prompt: string;
  readonly altText: string;
  readonly aspectRatio: string;
  readonly suggestedFilename: string;
  readonly caption?: string | undefined;
  readonly placementContext?: string | undefined;
}

const ImageSpecificationSchema: z.ZodType<ImageSpecification> = z
  .object({
    id: z.string().trim().min(1),
    type: z.enum(['featured', 'opengraph', 'twitter', 'section']),
    prompt: z.string().trim().min(1),
    altText: z.string().trim().min(1),
    aspectRatio: z.string().trim().min(1),
    suggestedFilename: z.string().trim().min(1),
    caption: z.string().trim().min(1).optional(),
    placementContext: z.string().trim().min(1).optional(),
  })
  .strict();

/** Image style guide for consistency. */
export interface ImageStyleGuide {
  readonly style: string;
  readonly colorPalette: readonly string[];
  readonly mood: string;
  readonly compositionNotes: string;
}

const ImageStyleGuideSchema: z.ZodType<ImageStyleGuide> = z
  .object({
    style: z.string().trim().min(1),
    colorPalette: z.array(z.string().trim().min(1)).min(1),
    mood: z.string().trim().min(1),
    compositionNotes: z.string().trim().min(1),
  })
  .strict();

/** Complete images section. */
export interface ImagesAssets {
  readonly featured: ImageSpecification;
  readonly openGraph: ImageSpecification;
  readonly twitter: ImageSpecification;
  readonly sectionImages: readonly ImageSpecification[];
  readonly styleGuide: ImageStyleGuide;
}

const ImagesAssetsSchema: z.ZodType<ImagesAssets> = z
  .object({
    featured: ImageSpecificationSchema,
    openGraph: ImageSpecificationSchema,
    twitter: ImageSpecificationSchema,
    sectionImages: z.array(ImageSpecificationSchema),
    styleGuide: ImageStyleGuideSchema,
  })
  .strict();

/** Infographic specification. */
export interface InfographicSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly dataPoints: readonly string[];
  readonly suggestedFormat: string;
  readonly placementContext: string;
}

const InfographicSpecSchema: z.ZodType<InfographicSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    dataPoints: z.array(z.string().trim().min(1)).min(1),
    suggestedFormat: z.string().trim().min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Comparison table specification. */
export interface ComparisonTableSpec {
  readonly id: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly string[];
  readonly placementContext: string;
}

const ComparisonTableSpecSchema: z.ZodType<ComparisonTableSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    columns: z.array(z.string().trim().min(1)).min(2),
    rows: z.array(z.string().trim().min(1)).min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Timeline specification. */
export interface TimelineSpec {
  readonly id: string;
  readonly title: string;
  readonly events: readonly {
    readonly date: string;
    readonly description: string;
  }[];
  readonly placementContext: string;
}

const TimelineEventSchema = z
  .object({
    date: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();

const TimelineSpecSchema: z.ZodType<TimelineSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    events: z.array(TimelineEventSchema).min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Chart specification. */
export interface ChartSpec {
  readonly id: string;
  readonly title: string;
  readonly chartType: 'bar' | 'line' | 'pie' | 'area' | 'scatter';
  readonly dataDescription: string;
  readonly xAxisLabel?: string | undefined;
  readonly yAxisLabel?: string | undefined;
  readonly placementContext: string;
}

const ChartSpecSchema: z.ZodType<ChartSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    chartType: z.enum(['bar', 'line', 'pie', 'area', 'scatter']),
    dataDescription: z.string().trim().min(1),
    xAxisLabel: z.string().trim().min(1).optional(),
    yAxisLabel: z.string().trim().min(1).optional(),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Diagram specification. */
export interface DiagramSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly diagramType: 'flowchart' | 'sequence' | 'mindmap' | 'architecture';
  readonly elements: readonly string[];
  readonly placementContext: string;
}

const DiagramSpecSchema: z.ZodType<DiagramSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    diagramType: z.enum(['flowchart', 'sequence', 'mindmap', 'architecture']),
    elements: z.array(z.string().trim().min(1)).min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Statistics callout specification. */
export interface StatisticsCalloutSpec {
  readonly id: string;
  readonly statistic: string;
  readonly source?: string | undefined;
  readonly context: string;
  readonly visualTreatment: string;
}

const StatisticsCalloutSpecSchema: z.ZodType<StatisticsCalloutSpec> = z
  .object({
    id: z.string().trim().min(1),
    statistic: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
    context: z.string().trim().min(1),
    visualTreatment: z.string().trim().min(1),
  })
  .strict();

/** Visual content section. */
export interface VisualContentAssets {
  readonly infographics: readonly InfographicSpec[];
  readonly comparisonTables: readonly ComparisonTableSpec[];
  readonly timelines: readonly TimelineSpec[];
  readonly charts: readonly ChartSpec[];
  readonly diagrams: readonly DiagramSpec[];
  readonly statisticsCallouts: readonly StatisticsCalloutSpec[];
}

const VisualContentAssetsSchema: z.ZodType<VisualContentAssets> = z
  .object({
    infographics: z.array(InfographicSpecSchema),
    comparisonTables: z.array(ComparisonTableSpecSchema),
    timelines: z.array(TimelineSpecSchema),
    charts: z.array(ChartSpecSchema),
    diagrams: z.array(DiagramSpecSchema),
    statisticsCallouts: z.array(StatisticsCalloutSpecSchema),
  })
  .strict();

/** Pull quote specification. */
export interface PullQuoteSpec {
  readonly id: string;
  readonly quote: string;
  readonly source?: string | undefined;
  readonly placementContext: string;
}

const PullQuoteSpecSchema: z.ZodType<PullQuoteSpec> = z
  .object({
    id: z.string().trim().min(1),
    quote: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Highlight box specification. */
export interface HighlightBoxSpec {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly style: 'info' | 'success' | 'warning' | 'error';
  readonly placementContext: string;
}

const HighlightBoxSpecSchema: z.ZodType<HighlightBoxSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
    style: z.enum(['info', 'success', 'warning', 'error']),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Tip box specification. */
export interface TipBoxSpec {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly placementContext: string;
}

const TipBoxSpecSchema: z.ZodType<TipBoxSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Warning box specification. */
export interface WarningBoxSpec {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly placementContext: string;
}

const WarningBoxSpecSchema: z.ZodType<WarningBoxSpec> = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    content: z.string().trim().min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** FAQ schema suggestion. */
export interface FaqSchemaSuggestion {
  readonly question: string;
  readonly answer: string;
  readonly placementContext: string;
}

const FaqSchemaSuggestionSchema: z.ZodType<FaqSchemaSuggestion> = z
  .object({
    question: z.string().trim().min(1),
    answer: z.string().trim().min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** CTA card specification. */
export interface CtaCardSpec {
  readonly id: string;
  readonly headline: string;
  readonly description: string;
  readonly buttonText: string;
  readonly buttonUrl: string;
  readonly style: string;
  readonly placementContext: string;
}

const CtaCardSpecSchema: z.ZodType<CtaCardSpec> = z
  .object({
    id: z.string().trim().min(1),
    headline: z.string().trim().min(1),
    description: z.string().trim().min(1),
    buttonText: z.string().trim().min(1),
    buttonUrl: z.string().trim().min(1),
    style: z.string().trim().min(1),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Newsletter CTA specification. */
export interface NewsletterCtaSpec {
  readonly headline: string;
  readonly description: string;
  readonly incentive?: string | undefined;
  readonly placementContext: string;
}

const NewsletterCtaSpecSchema: z.ZodType<NewsletterCtaSpec> = z
  .object({
    headline: z.string().trim().min(1),
    description: z.string().trim().min(1),
    incentive: z.string().trim().min(1).optional(),
    placementContext: z.string().trim().min(1),
  })
  .strict();

/** Content blocks section. */
export interface ContentBlocksAssets {
  readonly pullQuotes: readonly PullQuoteSpec[];
  readonly highlightBoxes: readonly HighlightBoxSpec[];
  readonly tipBoxes: readonly TipBoxSpec[];
  readonly warningBoxes: readonly WarningBoxSpec[];
  readonly faqSchemaSuggestions: readonly FaqSchemaSuggestion[];
  readonly ctaCards: readonly CtaCardSpec[];
  readonly newsletterCta?: NewsletterCtaSpec | undefined;
}

const ContentBlocksAssetsSchema: z.ZodType<ContentBlocksAssets> = z
  .object({
    pullQuotes: z.array(PullQuoteSpecSchema),
    highlightBoxes: z.array(HighlightBoxSpecSchema),
    tipBoxes: z.array(TipBoxSpecSchema),
    warningBoxes: z.array(WarningBoxSpecSchema),
    faqSchemaSuggestions: z.array(FaqSchemaSuggestionSchema),
    ctaCards: z.array(CtaCardSpecSchema),
    newsletterCta: NewsletterCtaSpecSchema.optional(),
  })
  .strict();

/** Social sharing metadata. */
export interface SocialSharingMetadata {
  readonly sharingDescription: string;
  readonly hashtags: readonly string[];
  readonly pinterestDescription: string;
  readonly youtubeDescriptionSuggestion?: string | undefined;
  readonly videoTopicSuggestions: readonly string[];
}

const SocialSharingMetadataSchema: z.ZodType<SocialSharingMetadata> = z
  .object({
    sharingDescription: z.string().trim().min(1),
    hashtags: z.array(z.string().trim().min(1)),
    pinterestDescription: z.string().trim().min(1),
    youtubeDescriptionSuggestion: z.string().trim().min(1).optional(),
    videoTopicSuggestions: z.array(z.string().trim().min(1)),
  })
  .strict();

/** Internal link suggestion. */
export interface InternalLinkSuggestion {
  readonly anchorText: string;
  readonly suggestedTargetTopic: string;
  readonly reason: string;
}

const InternalLinkSuggestionSchema: z.ZodType<InternalLinkSuggestion> = z
  .object({
    anchorText: z.string().trim().min(1),
    suggestedTargetTopic: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

/** Related article suggestion. */
export interface RelatedArticleSuggestion {
  readonly title: string;
  readonly topicOverlap: string;
  readonly suggestedPlacement: string;
}

const RelatedArticleSuggestionSchema: z.ZodType<RelatedArticleSuggestion> = z
  .object({
    title: z.string().trim().min(1),
    topicOverlap: z.string().trim().min(1),
    suggestedPlacement: z.string().trim().min(1),
  })
  .strict();

/** Downloadable asset suggestion. */
export interface DownloadableAssetSuggestion {
  readonly title: string;
  readonly format: 'pdf' | 'checklist' | 'template' | 'worksheet' | 'guide';
  readonly description: string;
  readonly suggestedContent: string;
}

const DownloadableAssetSuggestionSchema: z.ZodType<DownloadableAssetSuggestion> = z
  .object({
    title: z.string().trim().min(1),
    format: z.enum(['pdf', 'checklist', 'template', 'worksheet', 'guide']),
    description: z.string().trim().min(1),
    suggestedContent: z.string().trim().min(1),
  })
  .strict();

/** Lead magnet suggestion. */
export interface LeadMagnetSuggestion {
  readonly title: string;
  readonly type: string;
  readonly valueProposition: string;
  readonly suggestedContent: string;
}

const LeadMagnetSuggestionSchema: z.ZodType<LeadMagnetSuggestion> = z
  .object({
    title: z.string().trim().min(1),
    type: z.string().trim().min(1),
    valueProposition: z.string().trim().min(1),
    suggestedContent: z.string().trim().min(1),
  })
  .strict();

/** Internal assets section. */
export interface InternalAssets {
  readonly relatedArticleSuggestions: readonly RelatedArticleSuggestion[];
  readonly internalLinkOpportunities: readonly InternalLinkSuggestion[];
  readonly downloadableAssetSuggestions: readonly DownloadableAssetSuggestion[];
  readonly leadMagnetSuggestions: readonly LeadMagnetSuggestion[];
}

const InternalAssetsSchema: z.ZodType<InternalAssets> = z
  .object({
    relatedArticleSuggestions: z.array(RelatedArticleSuggestionSchema),
    internalLinkOpportunities: z.array(InternalLinkSuggestionSchema),
    downloadableAssetSuggestions: z.array(DownloadableAssetSuggestionSchema),
    leadMagnetSuggestions: z.array(LeadMagnetSuggestionSchema),
  })
  .strict();

/** Publishing metadata section. */
export interface PublishingMetadata {
  readonly heroImageSize: {
    readonly width: number;
    readonly height: number;
  };
  readonly featuredImageDimensions: {
    readonly width: number;
    readonly height: number;
  };
  readonly ogImageDimensions: {
    readonly width: number;
    readonly height: number;
  };
  readonly socialImageDimensions: {
    readonly width: number;
    readonly height: number;
  };
  readonly accessibilityRecommendations: readonly string[];
  readonly assetChecklist: readonly string[];
}

const PublishingMetadataSchema: z.ZodType<PublishingMetadata> = z
  .object({
    heroImageSize: z
      .object({
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .strict(),
    featuredImageDimensions: z
      .object({
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .strict(),
    ogImageDimensions: z
      .object({
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .strict(),
    socialImageDimensions: z
      .object({
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .strict(),
    accessibilityRecommendations: z.array(z.string().trim().min(1)),
    assetChecklist: z.array(z.string().trim().min(1)),
  })
  .strict();

/**
 * The complete immutable assets result exposed to downstream modules.
 * This is the rich output that provides comprehensive asset specifications
 * without generating any binary content.
 */
export interface AssetsResult {
  readonly images: ImagesAssets;
  readonly visualContent: VisualContentAssets;
  readonly contentBlocks: ContentBlocksAssets;
  readonly socialMetadata: SocialSharingMetadata;
  readonly internalAssets: InternalAssets;
  readonly publishingMetadata: PublishingMetadata;
  readonly generationSummary: string;
}

export const AssetsResultSchema: z.ZodType<AssetsResult> = z
  .object({
    images: ImagesAssetsSchema,
    visualContent: VisualContentAssetsSchema,
    contentBlocks: ContentBlocksAssetsSchema,
    socialMetadata: SocialSharingMetadataSchema,
    internalAssets: InternalAssetsSchema,
    publishingMetadata: PublishingMetadataSchema,
    generationSummary: z.string().trim().min(1),
  })
  .strict();

/** JSON-schema request supplied only when the selected provider supports it. */
export const AssetsResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'images',
    'visualContent',
    'contentBlocks',
    'socialMetadata',
    'internalAssets',
    'publishingMetadata',
    'generationSummary',
  ],
  properties: {
    images: {
      type: 'object',
      additionalProperties: false,
      required: ['featured', 'openGraph', 'twitter', 'sectionImages', 'styleGuide'],
      properties: {
        featured: imageSpecJsonSchema(),
        openGraph: imageSpecJsonSchema(),
        twitter: imageSpecJsonSchema(),
        sectionImages: { type: 'array', items: imageSpecJsonSchema() },
        styleGuide: {
          type: 'object',
          additionalProperties: false,
          required: ['style', 'colorPalette', 'mood', 'compositionNotes'],
          properties: {
            style: { type: 'string' },
            colorPalette: { type: 'array', items: { type: 'string' } },
            mood: { type: 'string' },
            compositionNotes: { type: 'string' },
          },
        },
      },
    },
    visualContent: {
      type: 'object',
      additionalProperties: false,
      required: [
        'infographics',
        'comparisonTables',
        'timelines',
        'charts',
        'diagrams',
        'statisticsCallouts',
      ],
      properties: {
        infographics: { type: 'array', items: infographicSpecJsonSchema() },
        comparisonTables: { type: 'array', items: comparisonTableSpecJsonSchema() },
        timelines: { type: 'array', items: timelineSpecJsonSchema() },
        charts: { type: 'array', items: chartSpecJsonSchema() },
        diagrams: { type: 'array', items: diagramSpecJsonSchema() },
        statisticsCallouts: { type: 'array', items: statisticsCalloutSpecJsonSchema() },
      },
    },
    contentBlocks: {
      type: 'object',
      additionalProperties: false,
      required: [
        'pullQuotes',
        'highlightBoxes',
        'tipBoxes',
        'warningBoxes',
        'faqSchemaSuggestions',
        'ctaCards',
      ],
      properties: {
        pullQuotes: { type: 'array', items: pullQuoteSpecJsonSchema() },
        highlightBoxes: { type: 'array', items: highlightBoxSpecJsonSchema() },
        tipBoxes: { type: 'array', items: tipBoxSpecJsonSchema() },
        warningBoxes: { type: 'array', items: warningBoxSpecJsonSchema() },
        faqSchemaSuggestions: { type: 'array', items: faqSchemaSuggestionJsonSchema() },
        ctaCards: { type: 'array', items: ctaCardSpecJsonSchema() },
        newsletterCta: newsletterCtaSpecJsonSchema(),
      },
    },
    socialMetadata: {
      type: 'object',
      additionalProperties: false,
      required: ['sharingDescription', 'hashtags', 'pinterestDescription', 'videoTopicSuggestions'],
      properties: {
        sharingDescription: { type: 'string' },
        hashtags: { type: 'array', items: { type: 'string' } },
        pinterestDescription: { type: 'string' },
        youtubeDescriptionSuggestion: { type: 'string' },
        videoTopicSuggestions: { type: 'array', items: { type: 'string' } },
      },
    },
    internalAssets: {
      type: 'object',
      additionalProperties: false,
      required: [
        'relatedArticleSuggestions',
        'internalLinkOpportunities',
        'downloadableAssetSuggestions',
        'leadMagnetSuggestions',
      ],
      properties: {
        relatedArticleSuggestions: { type: 'array', items: relatedArticleSuggestionJsonSchema() },
        internalLinkOpportunities: { type: 'array', items: internalLinkSuggestionJsonSchema() },
        downloadableAssetSuggestions: {
          type: 'array',
          items: downloadableAssetSuggestionJsonSchema(),
        },
        leadMagnetSuggestions: { type: 'array', items: leadMagnetSuggestionJsonSchema() },
      },
    },
    publishingMetadata: {
      type: 'object',
      additionalProperties: false,
      required: [
        'heroImageSize',
        'featuredImageDimensions',
        'ogImageDimensions',
        'socialImageDimensions',
        'accessibilityRecommendations',
        'assetChecklist',
      ],
      properties: {
        heroImageSize: dimensionsJsonSchema(),
        featuredImageDimensions: dimensionsJsonSchema(),
        ogImageDimensions: dimensionsJsonSchema(),
        socialImageDimensions: dimensionsJsonSchema(),
        accessibilityRecommendations: { type: 'array', items: { type: 'string' } },
        assetChecklist: { type: 'array', items: { type: 'string' } },
      },
    },
    generationSummary: { type: 'string' },
  },
});

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze([...required]),
    properties: Object.freeze({ ...properties }),
  });
}

function imageSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'type', 'prompt', 'altText', 'aspectRatio', 'suggestedFilename'], {
    id: { type: 'string' },
    type: { type: 'string', enum: ['featured', 'opengraph', 'twitter', 'section'] },
    prompt: { type: 'string' },
    altText: { type: 'string' },
    aspectRatio: { type: 'string' },
    suggestedFilename: { type: 'string' },
    caption: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function infographicSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(
    ['id', 'title', 'description', 'dataPoints', 'suggestedFormat', 'placementContext'],
    {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      dataPoints: { type: 'array', items: { type: 'string' } },
      suggestedFormat: { type: 'string' },
      placementContext: { type: 'string' },
    },
  );
}

function comparisonTableSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'title', 'columns', 'rows', 'placementContext'], {
    id: { type: 'string' },
    title: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'string' } },
    placementContext: { type: 'string' },
  });
}

function timelineSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'title', 'events', 'placementContext'], {
    id: { type: 'string' },
    title: { type: 'string' },
    events: {
      type: 'array',
      items: objectSchema(['date', 'description'], {
        date: { type: 'string' },
        description: { type: 'string' },
      }),
    },
    placementContext: { type: 'string' },
  });
}

function chartSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'title', 'chartType', 'dataDescription', 'placementContext'], {
    id: { type: 'string' },
    title: { type: 'string' },
    chartType: { type: 'string', enum: ['bar', 'line', 'pie', 'area', 'scatter'] },
    dataDescription: { type: 'string' },
    xAxisLabel: { type: 'string' },
    yAxisLabel: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function diagramSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(
    ['id', 'title', 'description', 'diagramType', 'elements', 'placementContext'],
    {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      diagramType: { type: 'string', enum: ['flowchart', 'sequence', 'mindmap', 'architecture'] },
      elements: { type: 'array', items: { type: 'string' } },
      placementContext: { type: 'string' },
    },
  );
}

function statisticsCalloutSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'statistic', 'context', 'visualTreatment'], {
    id: { type: 'string' },
    statistic: { type: 'string' },
    source: { type: 'string' },
    context: { type: 'string' },
    visualTreatment: { type: 'string' },
  });
}

function pullQuoteSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'quote', 'placementContext'], {
    id: { type: 'string' },
    quote: { type: 'string' },
    source: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function highlightBoxSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'title', 'content', 'style', 'placementContext'], {
    id: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
    style: { type: 'string', enum: ['info', 'success', 'warning', 'error'] },
    placementContext: { type: 'string' },
  });
}

function tipBoxSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'title', 'content', 'placementContext'], {
    id: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function warningBoxSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['id', 'title', 'content', 'placementContext'], {
    id: { type: 'string' },
    title: { type: 'string' },
    content: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function faqSchemaSuggestionJsonSchema(): Record<string, unknown> {
  return objectSchema(['question', 'answer', 'placementContext'], {
    question: { type: 'string' },
    answer: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function ctaCardSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(
    ['id', 'headline', 'description', 'buttonText', 'buttonUrl', 'style', 'placementContext'],
    {
      id: { type: 'string' },
      headline: { type: 'string' },
      description: { type: 'string' },
      buttonText: { type: 'string' },
      buttonUrl: { type: 'string' },
      style: { type: 'string' },
      placementContext: { type: 'string' },
    },
  );
}

function newsletterCtaSpecJsonSchema(): Record<string, unknown> {
  return objectSchema(['headline', 'description', 'placementContext'], {
    headline: { type: 'string' },
    description: { type: 'string' },
    incentive: { type: 'string' },
    placementContext: { type: 'string' },
  });
}

function relatedArticleSuggestionJsonSchema(): Record<string, unknown> {
  return objectSchema(['title', 'topicOverlap', 'suggestedPlacement'], {
    title: { type: 'string' },
    topicOverlap: { type: 'string' },
    suggestedPlacement: { type: 'string' },
  });
}

function internalLinkSuggestionJsonSchema(): Record<string, unknown> {
  return objectSchema(['anchorText', 'suggestedTargetTopic', 'reason'], {
    anchorText: { type: 'string' },
    suggestedTargetTopic: { type: 'string' },
    reason: { type: 'string' },
  });
}

function downloadableAssetSuggestionJsonSchema(): Record<string, unknown> {
  return objectSchema(['title', 'format', 'description', 'suggestedContent'], {
    title: { type: 'string' },
    format: { type: 'string', enum: ['pdf', 'checklist', 'template', 'worksheet', 'guide'] },
    description: { type: 'string' },
    suggestedContent: { type: 'string' },
  });
}

function leadMagnetSuggestionJsonSchema(): Record<string, unknown> {
  return objectSchema(['title', 'type', 'valueProposition', 'suggestedContent'], {
    title: { type: 'string' },
    type: { type: 'string' },
    valueProposition: { type: 'string' },
    suggestedContent: { type: 'string' },
  });
}

function dimensionsJsonSchema(): Record<string, unknown> {
  return objectSchema(['width', 'height'], {
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  });
}

// ============================================================================
// Module Services Contract
// ============================================================================

/** Services injected by the composition root; no concrete provider leaks here. */
export interface ContentAssetsPlannerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const contentAssetsPlannerModuleMetadata: ModuleMetadata = Object.freeze({
  key: CONTENT_ASSETS_PLANNER_MODULE_KEY,
  displayName: 'Content Assets Planner',
  description:
    'Generates a complete asset blueprint (images, visual content, content blocks, SEO assets) for downstream publishers without producing binary content.',
  dependencies: Object.freeze([
    'research',
    'planner',
    'seo-planner',
    'writer',
    'reviewer-technical',
    'humanizer',
  ] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'research.structured-output',
      'planner.content-plan',
      'seo.strategy',
      'writer.draft',
      'reviewer.technical-review',
      'humanizer.humanized-draft',
    ]),
    provides: Object.freeze([
      'content-assets-planner.asset-blueprint',
      'content-assets-planner.image-specifications',
      'content-assets-planner.visual-content-specs',
      'content-assets-planner.state-projection',
    ]),
  }),
});

// ============================================================================
// State Projection Functions
// ============================================================================

/** Builds a validated request from the module-owned PipelineState reads. */
export function buildAssetsRequest(state: PipelineState): AssetsRequest {
  if (state.brief === undefined) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, ['state.brief is required.']);
  }
  if (state.research === undefined) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, ['state.research is required.']);
  }
  if (state.planning === undefined) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, ['state.planning is required.']);
  }
  if (state.seo === undefined) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, ['state.seo is required.']);
  }
  if (state.draft === undefined) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, ['state.draft is required.']);
  }
  if (state.review === undefined) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, ['state.review is required.']);
  }

  return normalizeAssetsRequest({
    brief: assertValid(BriefSchema, state.brief, CONTENT_ASSETS_PLANNER_MODULE_KEY),
    research: assertValid(ResearchSectionSchema, state.research, CONTENT_ASSETS_PLANNER_MODULE_KEY),
    planning: assertValid(PlanningSectionSchema, state.planning, CONTENT_ASSETS_PLANNER_MODULE_KEY),
    seo: assertValid(SeoSectionSchema, state.seo, CONTENT_ASSETS_PLANNER_MODULE_KEY),
    draft: assertValid(DraftSectionSchema, state.draft, CONTENT_ASSETS_PLANNER_MODULE_KEY),
    review: assertValid(ReviewSectionSchema, state.review, CONTENT_ASSETS_PLANNER_MODULE_KEY),
  });
}

/** Validates and freezes the Content Assets Planner module input contract. */
export function normalizeAssetsRequest(request: AssetsRequest): AssetsRequest {
  const parsed = assertValid(AssetsRequestSchema, request, CONTENT_ASSETS_PLANNER_MODULE_KEY);
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
 * Projects the rich assets result into the minimal PipelineState section.
 * This maintains backward compatibility with the existing state model.
 */
export function toAssetsSection(result: AssetsResult): AssetsSection {
  const validated = assertValid(AssetsResultSchema, result, CONTENT_ASSETS_PLANNER_MODULE_KEY);

  return deepFreeze({
    images: {
      featured: {
        id: validated.images.featured.id,
        prompt: validated.images.featured.prompt,
        altText: validated.images.featured.altText,
        aspectRatio: validated.images.featured.aspectRatio,
      },
      sectionCount: validated.images.sectionImages.length,
      styleGuide: validated.images.styleGuide.style,
    },
    visualContentCount: {
      infographics: validated.visualContent.infographics.length,
      charts: validated.visualContent.charts.length,
      diagrams: validated.visualContent.diagrams.length,
    },
    contentBlocksCount: {
      pullQuotes: validated.contentBlocks.pullQuotes.length,
      faqItems: validated.contentBlocks.faqSchemaSuggestions.length,
    },
    socialHashtags: validated.socialMetadata.hashtags,
    accessibilityNotes: validated.publishingMetadata.accessibilityRecommendations,
  });
}

/** Minimal assets section projected into PipelineState. */
export interface AssetsSection {
  readonly images: {
    readonly featured: {
      readonly id: string;
      readonly prompt: string;
      readonly altText: string;
      readonly aspectRatio: string;
    };
    readonly sectionCount: number;
    readonly styleGuide: string;
  };
  readonly visualContentCount: {
    readonly infographics: number;
    readonly charts: number;
    readonly diagrams: number;
  };
  readonly contentBlocksCount: {
    readonly pullQuotes: number;
    readonly faqItems: number;
  };
  readonly socialHashtags: readonly string[];
  readonly accessibilityNotes: readonly string[];
}

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Content Assets Planner module. */
export function createContentAssetsPlannerModule(): PipelineModule<
  AssetsRequest,
  AssetsResult,
  ContentAssetsPlannerModuleServices
> {
  return defineModule({
    metadata: contentAssetsPlannerModuleMetadata,
    execute: executeContentAssetsPlanner,
  });
}

/** Registers one Content Assets Planner module without triggering execution. */
export function registerContentAssetsPlannerModule(
  registry: ModuleRegistry<ContentAssetsPlannerModuleServices>,
  module: PipelineModule<
    AssetsRequest,
    AssetsResult,
    ContentAssetsPlannerModuleServices
  > = createContentAssetsPlannerModule(),
): ModuleRegistry<ContentAssetsPlannerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Content Assets Planner module. */
export function createContentAssetsPlannerModuleBinding(): OrchestratorModuleBinding<ContentAssetsPlannerModuleServices> {
  return Object.freeze({
    key: CONTENT_ASSETS_PLANNER_MODULE_KEY,
    createInput: (state: PipelineState): AssetsRequest => buildAssetsRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(AssetsResultSchema, output, CONTENT_ASSETS_PLANNER_MODULE_KEY);
      const assetsSection = toAssetsSection(result);

      return {
        ...state,
        // Store in a new assets section - this extends PipelineState
        // The assets section is not part of the core PipelineState yet
        // so we use a custom extension approach
        assets: assetsSection,
      } as PipelineState & { assets: AssetsSection };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

async function executeContentAssetsPlanner(
  input: AssetsRequest,
  context: ModuleExecutionContext<ContentAssetsPlannerModuleServices>,
): Promise<AssetsResult> {
  const request = normalizeAssetsRequest(input);

  // Build the prompt with all necessary context
  const prompt = await context.services.promptRegistry.get('content-assets-planner', {
    topic: request.brief.topic,
    targetAudience: request.brief.targetAudience ?? 'general readers',
    focusKeyword: request.seo.focusKeyword,
    seoKeywords: request.seo.seoKeywords.join(', '),
    draftMarkdown: request.draft.current.markdown,
    wordCount: String(request.draft.current.wordCount),
    targetWordCount: String(request.planning.targetWordCount),
    suggestedAngle: request.research.suggestedAngle,
    plannedOutline: formatPlannedOutline(request.planning),
    imageMarkers: formatImageMarkers(request.draft.current.imageMarkers),
    linkMarkers: formatLinkMarkers(request.draft.current.linkMarkers),
    researchFacts: formatResearchFacts(request.research),
    technicalIssues: formatReviewIssues(request.review.technical),
    seoIssues: formatReviewIssues(request.review.seo),
  });

  // Call the LLM provider
  const response = await context.services.llmProvider.complete({
    moduleKey: CONTENT_ASSETS_PLANNER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: AssetsResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, AssetsResultSchema, CONTENT_ASSETS_PLANNER_MODULE_KEY),
    );
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return result;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatPlannedOutline(planning: PlanningSection): string {
  return planning.outline
    .map(
      (item) =>
        `${'#'.repeat(item.level)} ${item.heading}\n${item.talkingPoints.map((point) => `  - ${point}`).join('\n')}`,
    )
    .join('\n\n');
}

function formatImageMarkers(
  markers: readonly {
    readonly markerId: string;
    readonly role: 'hero' | 'inline';
    readonly descriptionHint: string;
  }[],
): string {
  if (markers.length === 0) {
    return '- None';
  }

  return markers
    .map(
      (marker) => `- [${marker.role.toUpperCase()}] ${marker.markerId}: ${marker.descriptionHint}`,
    )
    .join('\n');
}

function formatLinkMarkers(
  markers: readonly {
    readonly markerId: string;
    readonly anchorTextHint: string;
  }[],
): string {
  if (markers.length === 0) {
    return '- None';
  }

  return markers.map((marker) => `- ${marker.markerId}: "${marker.anchorTextHint}"`).join('\n');
}

function formatResearchFacts(research: ResearchSection): string {
  const facts = research.keyFacts.map((fact) => `- ${fact}`).join('\n');
  const statistics = research.candidateStatistics
    .map(
      (stat) => `- ${stat.claim}${stat.informalSource ? ` (Source: ${stat.informalSource})` : ''}`,
    )
    .join('\n');

  return `Key Facts:\n${facts}\n\nCandidate Statistics:\n${statistics}`;
}

function formatReviewIssues(
  review:
    | {
        readonly issues: readonly {
          readonly severity: string;
          readonly location: string;
          readonly description: string;
          readonly suggestedFix?: string | undefined;
        }[];
      }
    | undefined,
): string {
  if (review === undefined || review.issues.length === 0) {
    return '- None identified';
  }

  return review.issues
    .map(
      (issue) =>
        `- [${issue.severity.toUpperCase()}] ${issue.location}: ${issue.description}${issue.suggestedFix ? ` (Suggested: ${issue.suggestedFix})` : ''}`,
    )
    .join('\n');
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

function toCostEvent(
  response: LLMCallResult,
  promptVersion: string,
  outcome: 'success' | 'validationError',
) {
  if (!PROVIDER_NAMES.has(response.providerName as ProviderName)) {
    throw new ValidationError(CONTENT_ASSETS_PLANNER_MODULE_KEY, [
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
