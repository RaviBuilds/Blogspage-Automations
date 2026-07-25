/**
 * Provider-agnostic Fact & Quality Reviewer module.
 *
 * The module analyzes the generated draft against the Research, Planner, and SEO
 * outputs without rewriting the article. It produces a structured review report
 * identifying issues and providing scores. Provider invocation, timing,
 * cost-event persistence, scheduling, and checkpointing remain owned by
 * ModuleRunner and PipelineOrchestrator.
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
  DraftSectionSchema,
  PlanningSectionSchema,
  ResearchSectionSchema,
  ReviewOutputSchema,
  SeoSectionSchema,
  type DraftSection,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type ReviewOutput,
  type SeoSection,
} from '@/core/state.js';
import type { ProviderName } from '@/core/types.js';
import { parseJsonWithSchema } from '@/lib/json.js';
import { assertValid } from '@/lib/schemaValidator.js';
import type { PromptRegistry } from '@/prompts/registry.js';
import type { LLMCallResult, LLMProvider } from '@/providers/llm/LLMProvider.js';

const REVIEWER_MODULE_KEY = 'reviewer-technical' as const;
const MAX_OUTPUT_TOKENS = 4_000;
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

/** Stable, persisted inputs available to the Technical Reviewer through PipelineState. */
export interface ReviewRequest {
  readonly research: ResearchSection;
  readonly planning: PlanningSection;
  readonly seo: SeoSection;
  readonly draft: DraftSection;
}

export const ReviewRequestSchema: z.ZodType<ReviewRequest> = z
  .object({
    research: ResearchSectionSchema,
    planning: PlanningSectionSchema,
    seo: SeoSectionSchema,
    draft: DraftSectionSchema,
  })
  .strict();

// ============================================================================
// Output Contract - Rich Review Result
// ============================================================================

/** A score category with 0-100 range. */
export interface ScoreCategory {
  readonly score: number;
  readonly reasoning: string;
}

const ScoreCategorySchema: z.ZodType<ScoreCategory> = z
  .object({
    score: z.number().int().min(0).max(100),
    reasoning: z.string().trim().min(1),
  })
  .strict();

/** An unsupported claim found in the draft. */
export interface UnsupportedClaim {
  readonly claim: string;
  readonly location: string;
  readonly reason: string;
}

const UnsupportedClaimSchema: z.ZodType<UnsupportedClaim> = z
  .object({
    claim: z.string().trim().min(1),
    location: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();

/** A contradiction detected in the draft. */
export interface Contradiction {
  readonly statement1: string;
  readonly statement2: string;
  readonly location1: string;
  readonly location2: string;
  readonly description: string;
}

const ContradictionSchema: z.ZodType<Contradiction> = z
  .object({
    statement1: z.string().trim().min(1),
    statement2: z.string().trim().min(1),
    location1: z.string().trim().min(1),
    location2: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })
  .strict();

/** A missing planned section. */
export interface MissingPlannedSection {
  readonly heading: string;
  readonly plannedTalkingPoints: readonly string[];
}

const MissingPlannedSectionSchema: z.ZodType<MissingPlannedSection> = z
  .object({
    heading: z.string().trim().min(1),
    plannedTalkingPoints: z.array(z.string().trim().min(1)),
  })
  .strict();

/** A missing SEO requirement. */
export interface MissingSeoRequirement {
  readonly requirement: string;
  readonly expected: string;
  readonly actual?: string | undefined;
}

const MissingSeoRequirementSchema: z.ZodType<MissingSeoRequirement> = z
  .object({
    requirement: z.string().trim().min(1),
    expected: z.string().trim().min(1),
    actual: z.string().trim().min(1).optional(),
  })
  .strict();

/** A heading hierarchy issue. */
export interface HeadingHierarchyIssue {
  readonly issue: string;
  readonly location: string;
}

const HeadingHierarchyIssueSchema: z.ZodType<HeadingHierarchyIssue> = z
  .object({
    issue: z.string().trim().min(1),
    location: z.string().trim().min(1),
  })
  .strict();

/** A markdown formatting issue. */
export interface MarkdownFormattingIssue {
  readonly issue: string;
  readonly location: string;
  readonly suggestion?: string | undefined;
}

const MarkdownFormattingIssueSchema: z.ZodType<MarkdownFormattingIssue> = z
  .object({
    issue: z.string().trim().min(1),
    location: z.string().trim().min(1),
    suggestion: z.string().trim().min(1).optional(),
  })
  .strict();

/** Keyword stuffing detection. */
export interface KeywordStuffingInstance {
  readonly keyword: string;
  readonly count: number;
  readonly recommendedMax: number;
  readonly locations: readonly string[];
}

const KeywordStuffingInstanceSchema: z.ZodType<KeywordStuffingInstance> = z
  .object({
    keyword: z.string().trim().min(1),
    count: z.number().int().min(1),
    recommendedMax: z.number().int().min(1),
    locations: z.array(z.string().trim().min(1)),
  })
  .strict();

/** Repetitive paragraph detection. */
export interface RepetitiveParagraph {
  readonly paragraph1Location: string;
  readonly paragraph2Location: string;
  readonly similarity: string;
}

const RepetitiveParagraphSchema: z.ZodType<RepetitiveParagraph> = z
  .object({
    paragraph1Location: z.string().trim().min(1),
    paragraph2Location: z.string().trim().min(1),
    similarity: z.string().trim().min(1),
  })
  .strict();

/** Tone consistency issue. */
export interface ToneConsistencyIssue {
  readonly location: string;
  readonly expectedTone: string;
  readonly detectedTone: string;
  readonly excerpt: string;
}

const ToneConsistencyIssueSchema: z.ZodType<ToneConsistencyIssue> = z
  .object({
    location: z.string().trim().min(1),
    expectedTone: z.string().trim().min(1),
    detectedTone: z.string().trim().min(1),
    excerpt: z.string().trim().min(1),
  })
  .strict();

/** Placeholder validation issue. */
export interface PlaceholderIssue {
  readonly placeholder: string;
  readonly location: string;
  readonly issue: string;
}

const PlaceholderIssueSchema: z.ZodType<PlaceholderIssue> = z
  .object({
    placeholder: z.string().trim().min(1),
    location: z.string().trim().min(1),
    issue: z.string().trim().min(1),
  })
  .strict();

/** Image marker validation issue. */
export interface ImageMarkerIssue {
  readonly markerId: string;
  readonly issue: string;
}

const ImageMarkerIssueSchema: z.ZodType<ImageMarkerIssue> = z
  .object({
    markerId: z.string().trim().min(1),
    issue: z.string().trim().min(1),
  })
  .strict();

/** Link marker validation issue. */
export interface LinkMarkerIssue {
  readonly markerId: string;
  readonly issue: string;
}

const LinkMarkerIssueSchema: z.ZodType<LinkMarkerIssue> = z
  .object({
    markerId: z.string().trim().min(1),
    issue: z.string().trim().min(1),
  })
  .strict();

/** Review issue with severity classification. */
export interface ReviewIssueItem {
  readonly severity: 'critical' | 'warning' | 'info';
  readonly category: string;
  readonly description: string;
  readonly location?: string | undefined;
  readonly suggestedFix?: string | undefined;
}

const ReviewIssueItemSchema: z.ZodType<ReviewIssueItem> = z
  .object({
    severity: z.enum(['critical', 'warning', 'info']),
    category: z.string().trim().min(1),
    description: z.string().trim().min(1),
    location: z.string().trim().min(1).optional(),
    suggestedFix: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * The complete immutable review result exposed to downstream modules.
 * This is the rich output that gets projected into the minimal PipelineState ReviewSection.
 */
export interface ReviewResult {
  readonly overallScore: number;
  readonly structureScore: ScoreCategory;
  readonly researchAlignmentScore: ScoreCategory;
  readonly seoAlignmentScore: ScoreCategory;
  readonly readabilityScore: ScoreCategory;
  readonly completenessScore: ScoreCategory;
  readonly eeatScore: ScoreCategory;
  readonly factualConsistencyScore: ScoreCategory;
  readonly unsupportedClaims: readonly UnsupportedClaim[];
  readonly contradictions: readonly Contradiction[];
  readonly missingPlannedSections: readonly MissingPlannedSection[];
  readonly missingSeoRequirements: readonly MissingSeoRequirement[];
  readonly headingHierarchyIssues: readonly HeadingHierarchyIssue[];
  readonly markdownFormattingIssues: readonly MarkdownFormattingIssue[];
  readonly keywordStuffingInstances: readonly KeywordStuffingInstance[];
  readonly repetitiveParagraphs: readonly RepetitiveParagraph[];
  readonly toneConsistencyIssues: readonly ToneConsistencyIssue[];
  readonly placeholderIssues: readonly PlaceholderIssue[];
  readonly imageMarkerIssues: readonly ImageMarkerIssue[];
  readonly linkMarkerIssues: readonly LinkMarkerIssue[];
  readonly criticalIssues: readonly ReviewIssueItem[];
  readonly warningIssues: readonly ReviewIssueItem[];
  readonly informationalRecommendations: readonly ReviewIssueItem[];
  readonly reviewerSummary: string;
}

export const ReviewResultSchema: z.ZodType<ReviewResult> = z
  .object({
    overallScore: z.number().int().min(0).max(100),
    structureScore: ScoreCategorySchema,
    researchAlignmentScore: ScoreCategorySchema,
    seoAlignmentScore: ScoreCategorySchema,
    readabilityScore: ScoreCategorySchema,
    completenessScore: ScoreCategorySchema,
    eeatScore: ScoreCategorySchema,
    factualConsistencyScore: ScoreCategorySchema,
    unsupportedClaims: z.array(UnsupportedClaimSchema),
    contradictions: z.array(ContradictionSchema),
    missingPlannedSections: z.array(MissingPlannedSectionSchema),
    missingSeoRequirements: z.array(MissingSeoRequirementSchema),
    headingHierarchyIssues: z.array(HeadingHierarchyIssueSchema),
    markdownFormattingIssues: z.array(MarkdownFormattingIssueSchema),
    keywordStuffingInstances: z.array(KeywordStuffingInstanceSchema),
    repetitiveParagraphs: z.array(RepetitiveParagraphSchema),
    toneConsistencyIssues: z.array(ToneConsistencyIssueSchema),
    placeholderIssues: z.array(PlaceholderIssueSchema),
    imageMarkerIssues: z.array(ImageMarkerIssueSchema),
    linkMarkerIssues: z.array(LinkMarkerIssueSchema),
    criticalIssues: z.array(ReviewIssueItemSchema),
    warningIssues: z.array(ReviewIssueItemSchema),
    informationalRecommendations: z.array(ReviewIssueItemSchema),
    reviewerSummary: z.string().trim().min(1),
  })
  .strict()
  .superRefine((result, context) => {
    // Verify overall score is derived from category scores
    const categoryScores = [
      result.structureScore.score,
      result.researchAlignmentScore.score,
      result.seoAlignmentScore.score,
      result.readabilityScore.score,
      result.completenessScore.score,
      result.eeatScore.score,
      result.factualConsistencyScore.score,
    ];
    const expectedAverage = Math.round(
      categoryScores.reduce((sum, score) => sum + score, 0) / categoryScores.length,
    );

    // Allow +/- 5 point tolerance for weighted calculations
    if (Math.abs(result.overallScore - expectedAverage) > 5) {
      context.addIssue({
        code: 'custom',
        path: ['overallScore'],
        message: `overallScore should be derived from category scores (expected ~${expectedAverage}, got ${result.overallScore}).`,
      });
    }
  });

/** JSON-schema request supplied only when the selected provider supports it. */
export const ReviewResultJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'overallScore',
    'structureScore',
    'researchAlignmentScore',
    'seoAlignmentScore',
    'readabilityScore',
    'completenessScore',
    'eeatScore',
    'factualConsistencyScore',
    'unsupportedClaims',
    'contradictions',
    'missingPlannedSections',
    'missingSeoRequirements',
    'headingHierarchyIssues',
    'markdownFormattingIssues',
    'keywordStuffingInstances',
    'repetitiveParagraphs',
    'toneConsistencyIssues',
    'placeholderIssues',
    'imageMarkerIssues',
    'linkMarkerIssues',
    'criticalIssues',
    'warningIssues',
    'informationalRecommendations',
    'reviewerSummary',
  ],
  properties: {
    overallScore: { type: 'integer', minimum: 0, maximum: 100 },
    structureScore: scoreCategoryJsonSchema(),
    researchAlignmentScore: scoreCategoryJsonSchema(),
    seoAlignmentScore: scoreCategoryJsonSchema(),
    readabilityScore: scoreCategoryJsonSchema(),
    completenessScore: scoreCategoryJsonSchema(),
    eeatScore: scoreCategoryJsonSchema(),
    factualConsistencyScore: scoreCategoryJsonSchema(),
    unsupportedClaims: {
      type: 'array',
      items: objectSchema(['claim', 'location', 'reason'], {
        claim: { type: 'string' },
        location: { type: 'string' },
        reason: { type: 'string' },
      }),
    },
    contradictions: {
      type: 'array',
      items: objectSchema(['statement1', 'statement2', 'location1', 'location2', 'description'], {
        statement1: { type: 'string' },
        statement2: { type: 'string' },
        location1: { type: 'string' },
        location2: { type: 'string' },
        description: { type: 'string' },
      }),
    },
    missingPlannedSections: {
      type: 'array',
      items: objectSchema(['heading', 'plannedTalkingPoints'], {
        heading: { type: 'string' },
        plannedTalkingPoints: { type: 'array', items: { type: 'string' } },
      }),
    },
    missingSeoRequirements: {
      type: 'array',
      items: objectSchema(['requirement', 'expected'], {
        requirement: { type: 'string' },
        expected: { type: 'string' },
        actual: { type: 'string' },
      }),
    },
    headingHierarchyIssues: {
      type: 'array',
      items: objectSchema(['issue', 'location'], {
        issue: { type: 'string' },
        location: { type: 'string' },
      }),
    },
    markdownFormattingIssues: {
      type: 'array',
      items: objectSchema(['issue', 'location'], {
        issue: { type: 'string' },
        location: { type: 'string' },
        suggestion: { type: 'string' },
      }),
    },
    keywordStuffingInstances: {
      type: 'array',
      items: objectSchema(['keyword', 'count', 'recommendedMax', 'locations'], {
        keyword: { type: 'string' },
        count: { type: 'integer' },
        recommendedMax: { type: 'integer' },
        locations: { type: 'array', items: { type: 'string' } },
      }),
    },
    repetitiveParagraphs: {
      type: 'array',
      items: objectSchema(['paragraph1Location', 'paragraph2Location', 'similarity'], {
        paragraph1Location: { type: 'string' },
        paragraph2Location: { type: 'string' },
        similarity: { type: 'string' },
      }),
    },
    toneConsistencyIssues: {
      type: 'array',
      items: objectSchema(['location', 'expectedTone', 'detectedTone', 'excerpt'], {
        location: { type: 'string' },
        expectedTone: { type: 'string' },
        detectedTone: { type: 'string' },
        excerpt: { type: 'string' },
      }),
    },
    placeholderIssues: {
      type: 'array',
      items: objectSchema(['placeholder', 'location', 'issue'], {
        placeholder: { type: 'string' },
        location: { type: 'string' },
        issue: { type: 'string' },
      }),
    },
    imageMarkerIssues: {
      type: 'array',
      items: objectSchema(['markerId', 'issue'], {
        markerId: { type: 'string' },
        issue: { type: 'string' },
      }),
    },
    linkMarkerIssues: {
      type: 'array',
      items: objectSchema(['markerId', 'issue'], {
        markerId: { type: 'string' },
        issue: { type: 'string' },
      }),
    },
    criticalIssues: {
      type: 'array',
      items: objectSchema(['severity', 'category', 'description'], {
        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
        category: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        suggestedFix: { type: 'string' },
      }),
    },
    warningIssues: {
      type: 'array',
      items: objectSchema(['severity', 'category', 'description'], {
        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
        category: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        suggestedFix: { type: 'string' },
      }),
    },
    informationalRecommendations: {
      type: 'array',
      items: objectSchema(['severity', 'category', 'description'], {
        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
        category: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        suggestedFix: { type: 'string' },
      }),
    },
    reviewerSummary: { type: 'string' },
  },
});

function scoreCategoryJsonSchema(): Record<string, unknown> {
  return objectSchema(['score', 'reasoning'], {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    reasoning: { type: 'string' },
  });
}

// ============================================================================
// Module Services Contract
// ============================================================================

/** Services injected by the composition root; no concrete provider leaks here. */
export interface ReviewerModuleServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
}

// ============================================================================
// Module Metadata
// ============================================================================

/** Immutable metadata exposed through ModuleRegistry discovery. */
export const reviewerModuleMetadata: ModuleMetadata = Object.freeze({
  key: REVIEWER_MODULE_KEY,
  displayName: 'Technical Reviewer',
  description:
    'Analyzes the generated draft against research, planning, and SEO outputs to produce a structured quality review without rewriting content.',
  dependencies: Object.freeze(['research', 'planner', 'seo-planner', 'writer'] as const),
  capabilities: Object.freeze({
    requires: Object.freeze([
      'llm.complete',
      'prompt-registry.get',
      'research.structured-output',
      'planner.content-plan',
      'seo.strategy',
      'writer.draft',
    ]),
    provides: Object.freeze(['reviewer.technical-review', 'reviewer.state-projection']),
  }),
});

// ============================================================================
// State Projection Functions
// ============================================================================

/** Builds a validated request from the module-owned PipelineState reads. */
export function buildReviewerRequest(state: PipelineState): ReviewRequest {
  if (state.research === undefined) {
    throw new ValidationError(REVIEWER_MODULE_KEY, ['state.research is required.']);
  }
  if (state.planning === undefined) {
    throw new ValidationError(REVIEWER_MODULE_KEY, ['state.planning is required.']);
  }
  if (state.seo === undefined) {
    throw new ValidationError(REVIEWER_MODULE_KEY, ['state.seo is required.']);
  }
  if (state.draft === undefined) {
    throw new ValidationError(REVIEWER_MODULE_KEY, ['state.draft is required.']);
  }

  return normalizeReviewerRequest({
    research: assertValid(ResearchSectionSchema, state.research, REVIEWER_MODULE_KEY),
    planning: assertValid(PlanningSectionSchema, state.planning, REVIEWER_MODULE_KEY),
    seo: assertValid(SeoSectionSchema, state.seo, REVIEWER_MODULE_KEY),
    draft: assertValid(DraftSectionSchema, state.draft, REVIEWER_MODULE_KEY),
  });
}

/** Validates and freezes the Reviewer module input contract. */
export function normalizeReviewerRequest(request: ReviewRequest): ReviewRequest {
  const parsed = assertValid(ReviewRequestSchema, request, REVIEWER_MODULE_KEY);
  return deepFreeze({
    research: parsed.research,
    planning: parsed.planning,
    seo: parsed.seo,
    draft: parsed.draft,
  });
}

/**
 * Projects the rich review result into the minimal PipelineState ReviewOutput contract.
 * This is the backward-compatible projection that existing orchestrator code expects.
 */
export function toReviewOutput(result: ReviewResult): ReviewOutput {
  const validated = assertValid(ReviewResultSchema, result, REVIEWER_MODULE_KEY);

  // Collect all issues with proper ID generation
  const allIssues = [
    ...validated.criticalIssues.map((issue, index) => ({
      id: `critical-${index}`,
      severity: 'high' as const,
      location: issue.location ?? 'document',
      description: issue.description,
      suggestedFix: issue.suggestedFix,
    })),
    ...validated.warningIssues.map((issue, index) => ({
      id: `warning-${index}`,
      severity: 'medium' as const,
      location: issue.location ?? 'document',
      description: issue.description,
      suggestedFix: issue.suggestedFix,
    })),
    ...validated.informationalRecommendations.map((issue, index) => ({
      id: `info-${index}`,
      severity: 'low' as const,
      location: issue.location ?? 'document',
      description: issue.description,
      suggestedFix: issue.suggestedFix,
    })),
  ];

  // Determine if the draft passes based on critical issues and overall score
  const passed = validated.criticalIssues.length === 0 && validated.overallScore >= 60;

  return assertValid(
    ReviewOutputSchema,
    deepFreeze({
      passed,
      issues: allIssues,
    }),
    REVIEWER_MODULE_KEY,
  );
}

// ============================================================================
// Module Factory and Registration
// ============================================================================

/** Creates an independently testable, registry-discoverable Technical Reviewer module. */
export function createReviewerModule(): PipelineModule<
  ReviewRequest,
  ReviewResult,
  ReviewerModuleServices
> {
  return defineModule({
    metadata: reviewerModuleMetadata,
    execute: executeReviewer,
  });
}

/** Registers one Technical Reviewer module without triggering execution. */
export function registerReviewerModule(
  registry: ModuleRegistry<ReviewerModuleServices>,
  module: PipelineModule<
    ReviewRequest,
    ReviewResult,
    ReviewerModuleServices
  > = createReviewerModule(),
): ModuleRegistry<ReviewerModuleServices> {
  return registry.register(module);
}

/** Creates the orchestrator-only state adapter for the Technical Reviewer module. */
export function createReviewerModuleBinding(): OrchestratorModuleBinding<ReviewerModuleServices> {
  return Object.freeze({
    key: REVIEWER_MODULE_KEY,
    createInput: (state: PipelineState): ReviewRequest => buildReviewerRequest(state),
    applyOutput: (state: PipelineState, output: unknown): PipelineState => {
      const result = assertValid(ReviewResultSchema, output, REVIEWER_MODULE_KEY);
      const reviewOutput = toReviewOutput(result);

      return {
        ...state,
        review: {
          ...state.review,
          loop: state.review?.loop ?? { iteration: 0 },
          technical: reviewOutput,
        },
      };
    },
  });
}

// ============================================================================
// Execution Implementation
// ============================================================================

async function executeReviewer(
  input: ReviewRequest,
  context: ModuleExecutionContext<ReviewerModuleServices>,
): Promise<ReviewResult> {
  const request = normalizeReviewerRequest(input);

  // Build the prompt with all necessary context
  const prompt = await context.services.promptRegistry.get('reviewer-technical', {
    draftMarkdown: request.draft.current.markdown,
    wordCount: String(request.draft.current.wordCount),
    researchFacts: formatResearchFacts(request.research),
    plannedOutline: formatPlannedOutline(request.planning),
    focusKeyword: request.seo.focusKeyword,
    seoKeywords: request.seo.seoKeywords.join(', '),
    targetWordCount: String(request.planning.targetWordCount),
  });

  // Call the LLM provider
  const response = await context.services.llmProvider.complete({
    moduleKey: REVIEWER_MODULE_KEY,
    systemPrompt: prompt.system,
    userPrompt: prompt.user,
    responseFormat: 'json',
    ...(context.services.llmProvider.capabilities.jsonSchema
      ? { jsonSchema: ReviewResultJsonSchema }
      : {}),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  try {
    const result = deepFreeze(
      parseJsonWithSchema(response.text, ReviewResultSchema, REVIEWER_MODULE_KEY),
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

function formatResearchFacts(research: ResearchSection): string {
  const facts = research.keyFacts.map((fact) => `- ${fact}`).join('\n');
  const statistics = research.candidateStatistics
    .map(
      (stat) => `- ${stat.claim}${stat.informalSource ? ` (Source: ${stat.informalSource})` : ''}`,
    )
    .join('\n');

  return `Key Facts:\n${facts}\n\nCandidate Statistics:\n${statistics}`;
}

function formatPlannedOutline(planning: PlanningSection): string {
  return planning.outline
    .map(
      (item) =>
        `${'#'.repeat(item.level)} ${item.heading}\n${item.talkingPoints.map((point) => `  - ${point}`).join('\n')}`,
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
    throw new ValidationError(REVIEWER_MODULE_KEY, [
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
