/**
 * Provider-agnostic SEO Optimizer module.
 *
 * The module turns the persisted brief, research, and content-plan projections
 * into one immutable SEO strategy. Provider invocation, timing, cost-event
 * persistence, scheduling, and checkpointing remain owned by ModuleRunner and
 * PipelineOrchestrator.
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
  PlanningSectionSchema,
  ResearchSectionSchema,
  SeoSectionSchema,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type SeoSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const SEO_OPTIMIZER_MODULE_KEY = 'seo-planner' as const;
const DEFAULT_TARGET_AUDIENCE = 'General audience';
const MAX_OUTPUT_TOKENS = 3_200;
const PROVIDER_NAMES: ReadonlySet<ProviderName> = new Set([
  'anthropic',
  'openai',
  'gemini',
  'openrouter',
  'local',
]);

/** Stable, persisted inputs available to the SEO Optimizer through PipelineState. */
export interface SEORequest {
  readonly topic: string;
  readonly targetAudience: string;
  readonly keywordHints: readonly string[];
  readonly constraints: readonly string[];
  readonly research: ResearchSection;
  readonly planning: PlanningSection;
}

/** A secondary keyword's role and intended use in the eventual draft. */
export interface SecondaryKeywordStrategy {
  readonly keyword: string;
  readonly role: 'supporting' | 'semantic' | 'long-tail';
  readonly placement: string;
  readonly rationale: string;
}

/** A semantically related keyword group that covers one subtopic. */
export interface SemanticKeywordCluster {
  readonly topic: string;
  readonly keywords: readonly string[];
  readonly intent: string;
}

/** A relevant named concept that should be represented naturally in the copy. */
export interface NlpEntity {
  readonly name: string;
  readonly type: string;
  readonly relevance: 'high' | 'medium';
}

/** A focused lower-volume query opportunity. */
export interface LongTailKeywordOpportunity {
  readonly keyword: string;
  readonly intent: string;
  readonly rationale: string;
}

/** Validates that the planned article matches the intended search need. */
export interface SearchIntentValidation {
  readonly validatedIntent: string;
  readonly matchesResearchIntent: boolean;
  readonly rationale: string;
}

/** A query and content pattern that could support a featured snippet. */
export interface FeaturedSnippetOpportunity {
  readonly query: string;
  readonly format: 'paragraph' | 'list' | 'table';
  readonly recommendedAnswerAngle: string;
}

/** How one People Also Ask question is addressed by the planned article. */
export interface PeopleAlsoAskCoverage {
  readonly question: string;
  readonly coverageStatus: 'covered' | 'recommended';
  readonly placement: string;
}

/** A recommendation for FAQ coverage and structured-data inclusion. */
export interface FaqOptimizationRecommendation {
  readonly question: string;
  readonly answerGuidance: string;
  readonly includeInFaqSchema: boolean;
}

/** A heading-level SEO recommendation tied to the plan. */
export interface HeadingOptimizationGuidance {
  readonly heading: string;
  readonly level: 1 | 2 | 3;
  readonly recommendation: string;
  readonly keywordPlacement: string;
}

/** A validated URL slug recommendation. */
export interface UrlSlugValidation {
  readonly slug: string;
  readonly isValid: boolean;
  readonly rationale: string;
}

/** Canonical URL guidance for the future publisher. */
export interface CanonicalRecommendation {
  readonly recommendation: string;
  readonly rationale: string;
}

/** Internal-link guidance that remains site-inventory agnostic. */
export interface InternalLinkingStrategy {
  readonly anchorThemes: readonly string[];
  readonly implementationGuidance: string;
}

/** A trustworthy outside source category to support content claims. */
export interface ExternalAuthorityRecommendation {
  readonly sourceType: string;
  readonly recommendation: string;
  readonly rationale: string;
}

/** A supported structured-data type and its intended purpose. */
export interface SuggestedSchemaType {
  readonly type: 'Article' | 'FAQ' | 'Breadcrumb' | 'Organization' | 'LocalBusiness';
  readonly rationale: string;
}

/** Whether the content should use LocalBusiness structured data. */
export interface LocalBusinessApplicability {
  readonly applicable: boolean;
  readonly rationale: string;
}

/** Guidance for descriptive, context-aware image alternative text. */
export interface ImageAltTextGuidance {
  readonly patterns: readonly string[];
  readonly avoid: readonly string[];
  readonly requiredContext: string;
}

/** Guidance for stable, discoverable image filenames. */
export interface ImageFilenameGuidance {
  readonly pattern: string;
  readonly examples: readonly string[];
}

/** A recommendation that strengthens experience, expertise, authority, or trust. */
export interface EeatRecommendation {
  readonly recommendation: string;
  readonly evidenceType: string;
}

/** Measurable readability guidance for the future writer. */
export interface ReadabilityTargets {
  readonly targetReadingLevel: string;
  readonly targetSentenceLengthWords: number;
  readonly targetParagraphLengthSentences: number;
  readonly guidance: string;
}

/** A prioritized content opportunity absent from common competing coverage. */
export interface ContentGapRecommendation {
  readonly gap: string;
  readonly opportunity: string;
  readonly priority: 'high' | 'medium';
}

/** A natural keyword placement recommendation for a specific draft location. */
export interface KeywordPlacementRecommendation {
  readonly location: string;
  readonly keyword: string;
  readonly recommendation: string;
}

/**
 * Rich immutable SEO strategy exposed to downstream modules. The frozen state
 * projection intentionally retains only the pre-existing SeoSection fields.
 */
export interface SEOResult {
  readonly seoTitle: string;
  readonly seoTitleAlternatives: readonly string[];
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly primaryKeyword: string;
  readonly primaryKeywordConfirmation: string;
  readonly secondaryKeywordStrategy: readonly SecondaryKeywordStrategy[];
  readonly semanticKeywordClusters: readonly SemanticKeywordCluster[];
  readonly nlpEntities: readonly NlpEntity[];
  readonly longTailKeywordOpportunities: readonly LongTailKeywordOpportunity[];
  readonly searchIntentValidation: SearchIntentValidation;
  readonly featuredSnippetOpportunities: readonly FeaturedSnippetOpportunity[];
  readonly peopleAlsoAskCoverage: readonly PeopleAlsoAskCoverage[];
  readonly faqOptimizationRecommendations: readonly FaqOptimizationRecommendation[];
  readonly headingOptimizationGuidance: readonly HeadingOptimizationGuidance[];
  readonly urlSlugValidation: UrlSlugValidation;
  readonly canonicalRecommendation: CanonicalRecommendation;
  readonly internalLinkingStrategy: InternalLinkingStrategy;
  readonly externalAuthorityRecommendations: readonly ExternalAuthorityRecommendation[];
  readonly suggestedSchemaTypes: readonly SuggestedSchemaType[];
  readonly localBusinessApplicability: LocalBusinessApplicability;
  readonly imageAltTextGuidance: ImageAltTextGuidance;
  readonly imageFilenameGuidance: ImageFilenameGuidance;
  readonly eeatRecommendations: readonly EeatRecommendation[];
  readonly readabilityTargets: ReadabilityTargets;
  readonly contentGapRecommendations: readonly ContentGapRecommendation[];
  readonly keywordPlacementRecommendations: readonly KeywordPlacementRecommendation[];
  readonly seoScore?: number | undefined;
}

/** Services injected by the composition root; no concrete provider leaks here. */
export interface SEOOptimizerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

export const SEORequestSchema: z.ZodType<SEORequest> = z
  .object({
    topic: z.string().trim().min(1),
    targetAudience: z.string().trim().min(1),
    keywordHints: z.array(z.string().trim().min(1)),
    constraints: z.array(z.string().trim().min(1)),
    research: ResearchSectionSchema,
    planning: PlanningSectionSchema,
  })
  .strict();

const SecondaryKeywordStrategySchema: z.ZodType<SecondaryKeywordStrategy> = z
  .object({
    keyword: z.string().trim().min(1),
    role: z.enum(['supporting', 'semantic', 'long-tail']),
    placement: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
  })
  .strict();

const SemanticKeywordClusterSchema: z.ZodType<SemanticKeywordCluster> = z
  .object({
    topic: z.string().trim().min(1),
    keywords: z.array(z.string().trim().min(1)).min(1),
    intent: z.string().trim().min(1),
  })
  .strict();

const NlpEntitySchema: z.ZodType<NlpEntity> = z
  .object({
    name: z.string().trim().min(1),
    type: z.string().trim().min(1),
    relevance: z.enum(['high', 'medium']),
  })
  .strict();

const LongTailKeywordOpportunitySchema: z.ZodType<LongTailKeywordOpportunity> = z
  .object({
    keyword: z.string().trim().min(1),
    intent: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
  })
  .strict();

const SearchIntentValidationSchema: z.ZodType<SearchIntentValidation> = z
  .object({
    validatedIntent: z.string().trim().min(1),
    matchesResearchIntent: z.boolean(),
    rationale: z.string().trim().min(1),
  })
  .strict();

const FeaturedSnippetOpportunitySchema: z.ZodType<FeaturedSnippetOpportunity> = z
  .object({
    query: z.string().trim().min(1),
    format: z.enum(['paragraph', 'list', 'table']),
    recommendedAnswerAngle: z.string().trim().min(1),
  })
  .strict();

const PeopleAlsoAskCoverageSchema: z.ZodType<PeopleAlsoAskCoverage> = z
  .object({
    question: z.string().trim().min(1),
    coverageStatus: z.enum(['covered', 'recommended']),
    placement: z.string().trim().min(1),
  })
  .strict();

const FaqOptimizationRecommendationSchema: z.ZodType<FaqOptimizationRecommendation> = z
  .object({
    question: z.string().trim().min(1),
    answerGuidance: z.string().trim().min(1),
    includeInFaqSchema: z.boolean(),
  })
  .strict();

const HeadingOptimizationGuidanceSchema: z.ZodType<HeadingOptimizationGuidance> = z
  .object({
    heading: z.string().trim().min(1),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    recommendation: z.string().trim().min(1),
    keywordPlacement: z.string().trim().min(1),
  })
  .strict();

const UrlSlugValidationSchema: z.ZodType<UrlSlugValidation> = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    isValid: z.boolean(),
    rationale: z.string().trim().min(1),
  })
  .strict();

const CanonicalRecommendationSchema: z.ZodType<CanonicalRecommendation> = z
  .object({
    recommendation: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
  })
  .strict();

const InternalLinkingStrategySchema: z.ZodType<InternalLinkingStrategy> = z
  .object({
    anchorThemes: z.array(z.string().trim().min(1)),
    implementationGuidance: z.string().trim().min(1),
  })
  .strict();

const ExternalAuthorityRecommendationSchema: z.ZodType<ExternalAuthorityRecommendation> = z
  .object({
    sourceType: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
  })
  .strict();

const SuggestedSchemaTypeSchema: z.ZodType<SuggestedSchemaType> = z
  .object({
    type: z.enum(['Article', 'FAQ', 'Breadcrumb', 'Organization', 'LocalBusiness']),
    rationale: z.string().trim().min(1),
  })
  .strict();

const LocalBusinessApplicabilitySchema: z.ZodType<LocalBusinessApplicability> = z
  .object({
    applicable: z.boolean(),
    rationale: z.string().trim().min(1),
  })
  .strict();

const ImageAltTextGuidanceSchema: z.ZodType<ImageAltTextGuidance> = z
  .object({
    patterns: z.array(z.string().trim().min(1)).min(1),
    avoid: z.array(z.string().trim().min(1)).min(1),
    requiredContext: z.string().trim().min(1),
  })
  .strict();

const ImageFilenameGuidanceSchema: z.ZodType<ImageFilenameGuidance> = z
  .object({
    pattern: z.string().trim().min(1),
    examples: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const EeatRecommendationSchema: z.ZodType<EeatRecommendation> = z
  .object({
    recommendation: z.string().trim().min(1),
    evidenceType: z.string().trim().min(1),
  })
  .strict();

const ReadabilityTargetsSchema: z.ZodType<ReadabilityTargets> = z
  .object({
    targetReadingLevel: z.string().trim().min(1),
    targetSentenceLengthWords: z.number().int().min(5).max(30),
    targetParagraphLengthSentences: z.number().int().min(1).max(8),
    guidance: z.string().trim().min(1),
  })
  .strict();

const ContentGapRecommendationSchema: z.ZodType<ContentGapRecommendation> = z
  .object({
    gap: z.string().trim().min(1),
    opportunity: z.string().trim().min(1),
    priority: z.enum(['high', 'medium']),
  })
  .strict();

const KeywordPlacementRecommendationSchema: z.ZodType<KeywordPlacementRecommendation> = z
  .object({
    location: z.string().trim().min(1),
    keyword: z.string().trim().min(1),
    recommendation: z.string().trim().min(1),
  })
  .strict();

/** Runtime contract for every structured provider response. */
export const SEOResultSchema: z.ZodType<SEOResult> = z
  .object({
    seoTitle: z.string().trim().min(1),
    seoTitleAlternatives: z.array(z.string().trim().min(1)).min(3),
    metaTitle: z.string().trim().min(1),
    metaDescription: z.string().trim().min(1),
    primaryKeyword: z.string().trim().min(1),
    primaryKeywordConfirmation: z.string().trim().min(1),
    secondaryKeywordStrategy: z.array(SecondaryKeywordStrategySchema),
    semanticKeywordClusters: z.array(SemanticKeywordClusterSchema),
    nlpEntities: z.array(NlpEntitySchema),
    longTailKeywordOpportunities: z.array(LongTailKeywordOpportunitySchema),
    searchIntentValidation: SearchIntentValidationSchema,
    featuredSnippetOpportunities: z.array(FeaturedSnippetOpportunitySchema),
    peopleAlsoAskCoverage: z.array(PeopleAlsoAskCoverageSchema),
    faqOptimizationRecommendations: z.array(FaqOptimizationRecommendationSchema),
    headingOptimizationGuidance: z.array(HeadingOptimizationGuidanceSchema).min(1),
    urlSlugValidation: UrlSlugValidationSchema,
    canonicalRecommendation: CanonicalRecommendationSchema,
    internalLinkingStrategy: InternalLinkingStrategySchema,
    externalAuthorityRecommendations: z.array(ExternalAuthorityRecommendationSchema),
    suggestedSchemaTypes: z.array(SuggestedSchemaTypeSchema).min(1),
    localBusinessApplicability: LocalBusinessApplicabilitySchema,
    imageAltTextGuidance: ImageAltTextGuidanceSchema,
    imageFilenameGuidance: ImageFilenameGuidanceSchema,
    eeatRecommendations: z.array(EeatRecommendationSchema),
    readabilityTargets: ReadabilityTargetsSchema,
    contentGapRecommendations: z.array(ContentGapRecommendationSchema),
    keywordPlacementRecommendations: z.array(KeywordPlacementRecommendationSchema).min(1),
    seoScore: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (new Set(result.seoTitleAlternatives).size !== result.seoTitleAlternatives.length) {
      context.addIssue({
        code: 'custom',
        path: ['seoTitleAlternatives'],
        message: 'SEO title alternatives must be distinct.',
      });
    }

    if (!result.seoTitleAlternatives.includes(result.seoTitle)) {
      context.addIssue({
        code: 'custom',
        path: ['seoTitle'],
        message: 'SEO title must be one of the SEO title alternatives.',
      });
    }

    const schemaTypes = result.suggestedSchemaTypes.map((schemaType) => schemaType.type);
    if (!schemaTypes.includes('Article')) {
      context.addIssue({
        code: 'custom',
        path: ['suggestedSchemaTypes'],
        message: 'Suggested schema types must include Article.',
      });
    }
    if (new Set(schemaTypes).size !== schemaTypes.length) {
      context.addIssue({
        code: 'custom',
        path: ['suggestedSchemaTypes'],
        message: 'Suggested schema types must be distinct.',
      });
    }
    if (result.localBusinessApplicability.applicable && !schemaTypes.includes('LocalBusiness')) {
      context.addIssue({
        code: 'custom',
        path: ['suggestedSchemaTypes'],
        message: 'LocalBusiness schema is required when LocalBusiness is applicable.',
      });
    }
  });

/** JSON-schema request supplied only when the selected provider supports it. */
export const SEOResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'seoTitle',
    'seoTitleAlternatives',
    'metaTitle',
    'metaDescription',
    'primaryKeyword',
    'primaryKeywordConfirmation',
    'secondaryKeywordStrategy',
    'semanticKeywordClusters',
    'nlpEntities',
    'longTailKeywordOpportunities',
    'searchIntentValidation',
    'featuredSnippetOpportunities',
    'peopleAlsoAskCoverage',
    'faqOptimizationRecommendations',
    'headingOptimizationGuidance',
    'urlSlugValidation',
    'canonicalRecommendation',
    'internalLinkingStrategy',
    'externalAuthorityRecommendations',
    'suggestedSchemaTypes',
    'localBusinessApplicability',
    'imageAltTextGuidance',
    'imageFilenameGuidance',
    'eeatRecommendations',
    'readabilityTargets',
    'contentGapRecommendations',
    'keywordPlacementRecommendations',
  ],
  properties: {
    seoTitle: { type: 'string' },
    seoTitleAlternatives: { type: 'array', items: { type: 'string' } },
    metaTitle: { type: 'string' },
    metaDescription: { type: 'string' },
    primaryKeyword: { type: 'string' },
    primaryKeywordConfirmation: { type: 'string' },
    secondaryKeywordStrategy: {
      type: 'array',
      items: objectSchema(['keyword', 'role', 'placement', 'rationale'], {
        keyword: { type: 'string' },
        role: { type: 'string', enum: ['supporting', 'semantic', 'long-tail'] },
        placement: { type: 'string' },
        rationale: { type: 'string' },
      }),
    },
    semanticKeywordClusters: {
      type: 'array',
      items: objectSchema(['topic', 'keywords', 'intent'], {
        topic: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
        intent: { type: 'string' },
      }),
    },
    nlpEntities: {
      type: 'array',
      items: objectSchema(['name', 'type', 'relevance'], {
        name: { type: 'string' },
        type: { type: 'string' },
        relevance: { type: 'string', enum: ['high', 'medium'] },
      }),
    },
    longTailKeywordOpportunities: {
      type: 'array',
      items: objectSchema(['keyword', 'intent', 'rationale'], {
        keyword: { type: 'string' },
        intent: { type: 'string' },
        rationale: { type: 'string' },
      }),
    },
    searchIntentValidation: objectSchema(
      ['validatedIntent', 'matchesResearchIntent', 'rationale'],
      {
        validatedIntent: { type: 'string' },
        matchesResearchIntent: { type: 'boolean' },
        rationale: { type: 'string' },
      },
    ),
    featuredSnippetOpportunities: {
      type: 'array',
      items: objectSchema(['query', 'format', 'recommendedAnswerAngle'], {
        query: { type: 'string' },
        format: { type: 'string', enum: ['paragraph', 'list', 'table'] },
        recommendedAnswerAngle: { type: 'string' },
      }),
    },
    peopleAlsoAskCoverage: {
      type: 'array',
      items: objectSchema(['question', 'coverageStatus', 'placement'], {
        question: { type: 'string' },
        coverageStatus: { type: 'string', enum: ['covered', 'recommended'] },
        placement: { type: 'string' },
      }),
    },
    faqOptimizationRecommendations: {
      type: 'array',
      items: objectSchema(['question', 'answerGuidance', 'includeInFaqSchema'], {
        question: { type: 'string' },
        answerGuidance: { type: 'string' },
        includeInFaqSchema: { type: 'boolean' },
      }),
    },
    headingOptimizationGuidance: {
      type: 'array',
      items: objectSchema(['heading', 'level', 'recommendation', 'keywordPlacement'], {
        heading: { type: 'string' },
        level: { type: 'integer', enum: [1, 2, 3] },
        recommendation: { type: 'string' },
        keywordPlacement: { type: 'string' },
      }),
    },
    urlSlugValidation: objectSchema(['slug', 'isValid', 'rationale'], {
      slug: { type: 'string' },
      isValid: { type: 'boolean' },
      rationale: { type: 'string' },
    }),
    canonicalRecommendation: objectSchema(['recommendation', 'rationale'], {
      recommendation: { type: 'string' },
      rationale: { type: 'string' },
    }),
    internalLinkingStrategy: objectSchema(['anchorThemes', 'implementationGuidance'], {
      anchorThemes: { type: 'array', items: { type: 'string' } },
      implementationGuidance: { type: 'string' },
    }),
    externalAuthorityRecommendations: {
      type: 'array',
      items: objectSchema(['sourceType', 'recommendation', 'rationale'], {
        sourceType: { type: 'string' },
        recommendation: { type: 'string' },
        rationale: { type: 'string' },
      }),
    },
    suggestedSchemaTypes: {
      type: 'array',
      items: objectSchema(['type', 'rationale'], {
        type: {
          type: 'string',
          enum: ['Article', 'FAQ', 'Breadcrumb', 'Organization', 'LocalBusiness'],
        },
        rationale: { type: 'string' },
      }),
    },
    localBusinessApplicability: objectSchema(['applicable', 'rationale'], {
      applicable: { type: 'boolean' },
      rationale: { type: 'string' },
    }),
    imageAltTextGuidance: objectSchema(['patterns', 'avoid', 'requiredContext'], {
      patterns: { type: 'array', items: { type: 'string' } },
      avoid: { type: 'array', items: { type: 'string' } },
      requiredContext: { type: 'string' },
    }),
    imageFilenameGuidance: objectSchema(['pattern', 'examples'], {
      pattern: { type: 'string' },
      examples: { type: 'array', items: { type: 'string' } },
    }),
    eeatRecommendations: {
      type: 'array',
      items: objectSchema(['recommendation', 'evidenceType'], {
        recommendation: { type: 'string' },
        evidenceType: { type: 'string' },
      }),
    },
    readabilityTargets: objectSchema(
      [
        'targetReadingLevel',
        'targetSentenceLengthWords',
        'targetParagraphLengthSentences',
        'guidance',
      ],
      {
        targetReadingLevel: { type: 'string' },
        targetSentenceLengthWords: { type: 'integer' },
        targetParagraphLengthSentences: { type: 'integer' },
        guidance: { type: 'string' },
      },
    ),
    contentGapRecommendations: {
      type: 'array',
      items: objectSchema(['gap', 'opportunity', 'priority'], {
        gap: { type: 'string' },
        opportunity: { type: 'string' },
        priority: { type: 'string', enum: ['high', 'medium'] },
      }),
    },
    keywordPlacementRecommendations: {
      type: 'array',
      items: objectSchema(['location', 'keyword', 'recommendation'], {
        location: { type: 'string' },
        keyword: { type: 'string' },
        recommendation: { type: 'string' },
      }),
    },
    seoScore: { type: 'integer' },
  },
});

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const seoOptimizerModuleMetadata: ModuleMetadata = Object.freeze({
  key: SEO_OPTIMIZER_MODULE_KEY,
  displayName: 'SEO Optimizer',
  description: 'Transforms persisted research and content planning into an immutable SEO strategy.',
  dependencies: Object.freeze(['sheet-reader', 'research', 'planner'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'research.structured-output',
      'planner.content-plan',
    ]),
    provides: Object.freeze(['seo.strategy', 'seo.state-projection']),
  }),
});

/** Builds a validated request from the module-owned PipelineState reads. */
export function buildSEORequest(state: PipelineState): SEORequest {
  if (state.brief === undefined) {
    throw new ValidationError(SEO_OPTIMIZER_MODULE_KEY, ['state.brief is required.']);
  }
  if (state.research === undefined) {
    throw new ValidationError(SEO_OPTIMIZER_MODULE_KEY, ['state.research is required.']);
  }
  if (state.planning === undefined) {
    throw new ValidationError(SEO_OPTIMIZER_MODULE_KEY, ['state.planning is required.']);
  }

  const brief = assertValid(BriefSchema, state.brief, SEO_OPTIMIZER_MODULE_KEY);
  return normalizeSEORequest({
    topic: brief.topic,
    targetAudience: brief.targetAudience ?? DEFAULT_TARGET_AUDIENCE,
    keywordHints: normalizeStrings(brief.keywordHints),
    constraints: normalizeStrings(brief.constraints),
    research: assertValid(ResearchSectionSchema, state.research, SEO_OPTIMIZER_MODULE_KEY),
    planning: assertValid(PlanningSectionSchema, state.planning, SEO_OPTIMIZER_MODULE_KEY),
  });
}

/** Validates, normalizes, deduplicates, and freezes the SEO module input contract. */
export function normalizeSEORequest(request: SEORequest): SEORequest {
  const parsed = assertValid(SEORequestSchema, request, SEO_OPTIMIZER_MODULE_KEY);
  return deepFreeze({
    topic: parsed.topic,
    targetAudience: parsed.targetAudience,
    keywordHints: normalizeStrings(parsed.keywordHints),
    constraints: normalizeStrings(parsed.constraints),
    research: parsed.research,
    planning: parsed.planning,
  });
}

/** Projects the rich strategy into the frozen, minimal SeoSection contract. */
export function toSeoSection(result: SEOResult): SeoSection {
  const validated = assertValid(SEOResultSchema, result, SEO_OPTIMIZER_MODULE_KEY);
  return assertValid(
    SeoSectionSchema,
    deepFreeze({
      focusKeyword: validated.primaryKeyword,
      seoKeywords: normalizeStrings([
        validated.primaryKeyword,
        ...validated.secondaryKeywordStrategy.map((strategy) => strategy.keyword),
      ]),
      seoTitleDraft: validated.seoTitle,
      metaDescriptionDraft: validated.metaDescription,
      internalLinkTargets: [],
    }),
    SEO_OPTIMIZER_MODULE_KEY,
  );
}

/** Creates an independently testable, registry-discoverable SEO Optimizer module. */
export function createSEOOptimizerModule(): PipelineModule<
  SEORequest,
  SEOResult,
  SEOOptimizerModuleServices
> {
  return defineModule({
    metadata: seoOptimizerModuleMetadata,
    execute: executeSEOOptimizer,
  });
}

/** Registers one SEO Optimizer module without triggering execution. */
export function registerSEOOptimizerModule(
  registry: ModuleRegistry<SEOOptimizerModuleServices>,
  module: PipelineModule<
    SEORequest,
    SEOResult,
    SEOOptimizerModuleServices
  > = createSEOOptimizerModule(),
): ModuleRegistry<SEOOptimizerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the SEO Optimizer module. */
export function createSEOOptimizerModuleBinding(): OrchestratorModuleBinding<SEOOptimizerModuleServices> {
  return Object.freeze({
    key: SEO_OPTIMIZER_MODULE_KEY,
    createInput: (state: PipelineState): SEORequest => buildSEORequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => ({
      ...state,
      seo: toSeoSection(assertValid(SEOResultSchema, output, SEO_OPTIMIZER_MODULE_KEY)),
    }),
  });
}

async function executeSEOOptimizer(
  input: SEORequest,
  context: ModuleExecutionContext<SEOOptimizerModuleServices>,
): Promise<SEOResult> {
  const request = normalizeSEORequest(input);
  const prompt = await context.services.promptRegistry.get('seo-planner', {
    topic: request.topic,
    targetAudience: request.targetAudience,
    keywordHints: formatMarkdownList(request.keywordHints),
    constraints: formatMarkdownList(request.constraints),
    researchKeyFacts: formatMarkdownList(request.research.keyFacts),
    competitorGapNotes: formatMarkdownList(request.research.competitorGapNotes ?? []),
    plannedAngle: request.planning.angle,
    plannedTitles: formatMarkdownList(request.planning.titleCandidates),
    outline: formatOutline(request.planning),
  });
  const response = await context.services.llmProvider.complete({
    moduleKey: SEO_OPTIMIZER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: SEOResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, SEOResultSchema, SEO_OPTIMIZER_MODULE_KEY),
    );
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'success'));
    return result;
  } catch (error: unknown) {
    context.recordCost(toCostEvent(response, prompt.promptVersion, 'validationError'));
    throw error;
  }
}

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

function normalizeStrings(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze([
    ...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0)),
  ]);
}

function formatMarkdownList(values: readonly string[]): string {
  return values.length === 0 ? '- None provided' : values.map((value) => `- ${value}`).join('\n');
}

function formatOutline(planning: PlanningSection): string {
  return planning.outline
    .map(
      (item) =>
        `${'#'.repeat(item.level)} ${item.heading}\n${formatMarkdownList(item.talkingPoints)}`,
    )
    .join('\n\n');
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
    throw new ValidationError(SEO_OPTIMIZER_MODULE_KEY, [
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
