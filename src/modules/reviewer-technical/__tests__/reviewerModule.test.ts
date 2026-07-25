/**
 * Comprehensive unit tests for the Fact & Quality Reviewer module.
 *
 * Tests cover:
 * - Request normalization and validation
 * - Result schema validation
 * - State projection to ReviewOutput
 * - Module metadata and capabilities
 * - Orchestrator binding
 * - Error handling
 * - Cost integration
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, type ModuleRegistry, ModuleRunner } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type PipelineState,
  type ResearchSection,
  type PlanningSection,
  type SeoSection,
  type DraftSection,
} from '@/core/state.js';
import type { PromptKey } from '@/prompts/registry.js';
import type {
  LLMCallResult,
  LLMProvider,
  ProviderCapabilities,
} from '@/providers/llm/LLMProvider.js';
import {
  buildReviewerRequest,
  createReviewerModule,
  createReviewerModuleBinding,
  normalizeReviewerRequest,
  registerReviewerModule,
  reviewerModuleMetadata,
  ReviewRequestSchema,
  ReviewResultSchema,
  ReviewResultJsonSchema,
  toReviewOutput,
  type ReviewRequest,
  type ReviewResult,
  type ReviewerModuleServices,
} from '../reviewerModule.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const mockResearch: ResearchSection = Object.freeze({
  keyFacts: Object.freeze([
    'Fact 1 about the topic',
    'Fact 2 about the topic',
    'Fact 3 about the topic',
  ]),
  suggestedAngle: 'Focus on practical applications',
  competitorGapNotes: Object.freeze(['Competitor missing depth on advanced topics']),
  candidateStatistics: Object.freeze([
    { claim: '75% of users prefer X', informalSource: 'Survey 2024' },
    { claim: 'Market grew 40% YoY', informalSource: 'Industry Report' },
  ]),
});

const mockPlanning: PlanningSection = Object.freeze({
  titleCandidates: Object.freeze(['Title 1', 'Title 2', 'Title 3']),
  outline: Object.freeze([
    {
      heading: 'Introduction',
      level: 2 as const,
      talkingPoints: Object.freeze(['Hook the reader', 'State the problem']),
    },
    {
      heading: 'Main Section',
      level: 2 as const,
      talkingPoints: Object.freeze(['Explain concept', 'Provide examples']),
    },
    {
      heading: 'Conclusion',
      level: 2 as const,
      talkingPoints: Object.freeze(['Summarize key points', 'Call to action']),
    },
  ]),
  targetWordCount: 1500,
  angle: 'Practical guide for beginners',
});

const mockSeo: SeoSection = Object.freeze({
  focusKeyword: 'topic guide',
  seoKeywords: Object.freeze(['topic', 'guide', 'beginners', 'practical']),
  seoTitleDraft: 'Complete Topic Guide for Beginners',
  metaDescriptionDraft: 'Learn everything about topic in this comprehensive guide.',
  internalLinkTargets: Object.freeze([
    { candidateSlug: '/related-post', candidateTitle: 'Related Post', relevance: 'high' as const },
  ]),
});

const mockDraft: DraftSection = Object.freeze({
  current: Object.freeze({
    markdown: `# Complete Topic Guide for Beginners

## Introduction

This comprehensive guide will help you understand the topic. The problem affects many people today.

## Main Section

Here we explain the concept in detail. Fact 1 about the topic is important. Fact 2 about the topic provides context.

[[image:img-hero-001]]

### Subsection

More details and examples here.

[[link:link-internal-001]]

## Conclusion

We covered key points about the topic. Take action today!

[[image:img-inline-001]]`,
    wordCount: 800,
    linkMarkers: Object.freeze([
      { markerId: 'link-internal-001', anchorTextHint: 'related resource' },
    ]),
    imageMarkers: Object.freeze([
      { markerId: 'img-hero-001', role: 'hero' as const, descriptionHint: 'Hero image' },
      { markerId: 'img-inline-001', role: 'inline' as const, descriptionHint: 'Inline image' },
    ]),
  }),
  history: Object.freeze([]),
});

const validReviewRequest: ReviewRequest = Object.freeze({
  research: mockResearch,
  planning: mockPlanning,
  seo: mockSeo,
  draft: mockDraft,
});

const validReviewResult: ReviewResult = Object.freeze({
  overallScore: 75,
  structureScore: { score: 80, reasoning: 'Good heading structure' },
  researchAlignmentScore: { score: 70, reasoning: 'Most facts incorporated' },
  seoAlignmentScore: { score: 75, reasoning: 'Keyword usage appropriate' },
  readabilityScore: { score: 80, reasoning: 'Clear and accessible' },
  completenessScore: { score: 70, reasoning: 'Missing some planned sections' },
  eeatScore: { score: 65, reasoning: 'Could use more expertise signals' },
  factualConsistencyScore: { score: 80, reasoning: 'No major inconsistencies' },
  unsupportedClaims: Object.freeze([]),
  contradictions: Object.freeze([]),
  missingPlannedSections: Object.freeze([]),
  missingSeoRequirements: Object.freeze([]),
  headingHierarchyIssues: Object.freeze([]),
  markdownFormattingIssues: Object.freeze([]),
  keywordStuffingInstances: Object.freeze([]),
  repetitiveParagraphs: Object.freeze([]),
  toneConsistencyIssues: Object.freeze([]),
  placeholderIssues: Object.freeze([]),
  imageMarkerIssues: Object.freeze([]),
  linkMarkerIssues: Object.freeze([]),
  criticalIssues: Object.freeze([]),
  warningIssues: Object.freeze([
    {
      severity: 'warning' as const,
      category: 'completeness',
      description: 'Word count below target',
      location: 'document',
      suggestedFix: 'Expand sections to reach 1500 words',
    },
  ]),
  informationalRecommendations: Object.freeze([
    {
      severity: 'info' as const,
      category: 'eeat',
      description: 'Consider adding author credentials',
    },
  ]),
  reviewerSummary: 'The draft is solid but needs expansion to meet word count target.',
});

// ============================================================================
// Mock LLM Provider
// ============================================================================

class MockLLMProvider implements LLMProvider {
  public readonly capabilities: ProviderCapabilities = Object.freeze({
    vision: false,
    jsonSchema: true,
    caching: false,
    reasoning: false,
  });

  private nextResult: LLMCallResult | Error | undefined;

  public setNextResult(result: LLMCallResult | Error): void {
    this.nextResult = result;
  }

  public complete(): Promise<LLMCallResult> {
    if (this.nextResult === undefined) {
      throw new Error('MockLLMProvider: no result configured');
    }
    if (this.nextResult instanceof Error) {
      throw this.nextResult;
    }
    return Promise.resolve(this.nextResult);
  }
}

// ============================================================================
// Mock Prompt Registry
// ============================================================================

class MockPromptRegistry {
  private prompts: Map<PromptKey, { system: string; user: string; promptVersion: string }> =
    new Map();

  public setPrompt(
    key: PromptKey,
    prompt: { system: string; user: string; promptVersion: string },
  ): void {
    this.prompts.set(key, prompt);
  }

  public get(
    key: PromptKey,
    _vars: Readonly<Record<string, string>>,
  ): Promise<{ system: string; user: string; promptVersion: string }> {
    const prompt = this.prompts.get(key);
    if (prompt === undefined) {
      throw new Error(`MockPromptRegistry: no prompt for key "${key}"`);
    }
    return Promise.resolve(prompt);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('reviewerModule', () => {
  let mockLLMProvider: MockLLMProvider;
  let mockPromptRegistry: MockPromptRegistry;
  let services: ReviewerModuleServices;
  let registry: ModuleRegistry<ReviewerModuleServices>;
  let runner: ModuleRunner<ReviewerModuleServices>;

  beforeEach(() => {
    mockLLMProvider = new MockLLMProvider();
    mockPromptRegistry = new MockPromptRegistry();
    services = Object.freeze({
      llmProvider: mockLLMProvider,
      promptRegistry: mockPromptRegistry,
    });
    registry = createModuleRegistry<ReviewerModuleServices>();
    runner = new ModuleRunner({ registry });

    // Set up default prompt
    mockPromptRegistry.setPrompt('reviewer-technical', {
      system: 'You are a technical reviewer.',
      user: 'Review this draft.',
      promptVersion: 'abc123',
    });
  });

  // ==========================================================================
  // Schema Validation Tests
  // ==========================================================================

  describe('ReviewRequestSchema', () => {
    it('accepts a valid request', () => {
      const result = ReviewRequestSchema.safeParse(validReviewRequest);
      expect(result.success).toBe(true);
    });

    it('rejects missing research', () => {
      const request = { ...validReviewRequest, research: undefined };
      const result = ReviewRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects missing planning', () => {
      const request = { ...validReviewRequest, planning: undefined };
      const result = ReviewRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects missing seo', () => {
      const request = { ...validReviewRequest, seo: undefined };
      const result = ReviewRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects missing draft', () => {
      const request = { ...validReviewRequest, draft: undefined };
      const result = ReviewRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });

  describe('ReviewResultSchema', () => {
    it('accepts a valid result', () => {
      const result = ReviewResultSchema.safeParse(validReviewResult);
      expect(result.success).toBe(true);
    });

    it('rejects overall score out of range', () => {
      const result = {
        ...validReviewResult,
        overallScore: 150,
      };
      const parsed = ReviewResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
    });

    it('rejects category score out of range', () => {
      const result = {
        ...validReviewResult,
        structureScore: { score: 150, reasoning: 'Invalid' },
      };
      const parsed = ReviewResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
    });

    it('rejects missing required fields', () => {
      const result = {
        ...validReviewResult,
        reviewerSummary: undefined,
      };
      const parsed = ReviewResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
    });

    it('validates overall score derivation tolerance', () => {
      // Category average is ~74.3, so overall should be near 74
      const result = {
        ...validReviewResult,
        overallScore: 85, // Too far from average
      };
      const parsed = ReviewResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path.includes('overallScore'))).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Request Building Tests
  // ==========================================================================

  describe('buildReviewerRequest', () => {
    it('builds a valid request from complete state', () => {
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      const request = buildReviewerRequest(state);
      expect(request.research).toEqual(mockResearch);
      expect(request.planning).toEqual(mockPlanning);
      expect(request.seo).toEqual(mockSeo);
      expect(request.draft).toEqual(mockDraft);
    });

    it('throws ValidationError when research is missing', () => {
      const state: PipelineState = {
        ...createInitialState(),
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      expect(() => buildReviewerRequest(state)).toThrow(ValidationError);
    });

    it('throws ValidationError when planning is missing', () => {
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        seo: mockSeo,
        draft: mockDraft,
      };

      expect(() => buildReviewerRequest(state)).toThrow(ValidationError);
    });

    it('throws ValidationError when seo is missing', () => {
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        draft: mockDraft,
      };

      expect(() => buildReviewerRequest(state)).toThrow(ValidationError);
    });

    it('throws ValidationError when draft is missing', () => {
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
      };

      expect(() => buildReviewerRequest(state)).toThrow(ValidationError);
    });
  });

  // ==========================================================================
  // State Projection Tests
  // ==========================================================================

  describe('toReviewOutput', () => {
    it('projects a passing result correctly', () => {
      const output = toReviewOutput(validReviewResult);
      expect(output.passed).toBe(true);
      expect(output.issues).toHaveLength(2); // 1 warning + 1 info
    });

    it('projects a failing result with critical issues', () => {
      const result: ReviewResult = {
        ...validReviewResult,
        criticalIssues: Object.freeze([
          {
            severity: 'critical',
            category: 'factual',
            description: 'Major factual error',
            location: 'Main Section',
          },
        ]),
      };

      const output = toReviewOutput(result);
      expect(output.passed).toBe(false);
      expect(output.issues.some((issue) => issue.severity === 'high')).toBe(true);
    });

    it('projects a failing result with low overall score', () => {
      const result: ReviewResult = {
        ...validReviewResult,
        overallScore: 45,
        structureScore: { score: 40, reasoning: 'Poor' },
        researchAlignmentScore: { score: 40, reasoning: 'Poor' },
        seoAlignmentScore: { score: 50, reasoning: 'Poor' },
        readabilityScore: { score: 50, reasoning: 'Poor' },
        completenessScore: { score: 45, reasoning: 'Poor' },
        eeatScore: { score: 40, reasoning: 'Poor' },
        factualConsistencyScore: { score: 50, reasoning: 'Poor' },
      };

      const output = toReviewOutput(result);
      expect(output.passed).toBe(false);
    });

    it('maps issue severities correctly', () => {
      const result: ReviewResult = {
        ...validReviewResult,
        criticalIssues: Object.freeze([
          { severity: 'critical' as const, category: 'test', description: 'Critical 1' },
        ]),
        warningIssues: Object.freeze([
          { severity: 'warning' as const, category: 'test', description: 'Warning 1' },
        ]),
        informationalRecommendations: Object.freeze([
          { severity: 'info' as const, category: 'test', description: 'Info 1' },
        ]),
      };

      const output = toReviewOutput(result);
      expect(output.issues).toHaveLength(3);
      expect(output.issues.filter((i) => i.severity === 'high')).toHaveLength(1);
      expect(output.issues.filter((i) => i.severity === 'medium')).toHaveLength(1);
      expect(output.issues.filter((i) => i.severity === 'low')).toHaveLength(1);
    });

    it('generates unique issue IDs', () => {
      const result: ReviewResult = {
        ...validReviewResult,
        warningIssues: Object.freeze([
          { severity: 'warning' as const, category: 'test', description: 'Warning 1' },
          { severity: 'warning' as const, category: 'test', description: 'Warning 2' },
        ]),
      };

      const output = toReviewOutput(result);
      const ids = output.issues.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ==========================================================================
  // Module Metadata Tests
  // ==========================================================================

  describe('reviewerModuleMetadata', () => {
    it('has correct module key', () => {
      expect(reviewerModuleMetadata.key).toBe('reviewer-technical');
    });

    it('has non-empty displayName', () => {
      expect(reviewerModuleMetadata.displayName.length).toBeGreaterThan(0);
    });

    it('has non-empty description', () => {
      expect(reviewerModuleMetadata.description.length).toBeGreaterThan(0);
    });

    it('declares correct dependencies', () => {
      expect(reviewerModuleMetadata.dependencies).toContain('research');
      expect(reviewerModuleMetadata.dependencies).toContain('planner');
      expect(reviewerModuleMetadata.dependencies).toContain('seo-planner');
      expect(reviewerModuleMetadata.dependencies).toContain('writer');
    });

    it('declares required capabilities', () => {
      expect(reviewerModuleMetadata.capabilities.requires).toContain('llm.complete');
      expect(reviewerModuleMetadata.capabilities.requires).toContain('prompt-registry.get');
    });

    it('declares provided capabilities', () => {
      expect(reviewerModuleMetadata.capabilities.provides).toContain('reviewer.technical-review');
      expect(reviewerModuleMetadata.capabilities.provides).toContain('reviewer.state-projection');
    });
  });

  // ==========================================================================
  // Module Registration Tests
  // ==========================================================================

  describe('registerReviewerModule', () => {
    it('registers the module in the registry', () => {
      registerReviewerModule(registry);
      expect(registry.has('reviewer-technical')).toBe(true);
    });

    it('throws when registering twice', () => {
      registerReviewerModule(registry);
      expect(() => registerReviewerModule(registry)).toThrow(RangeError);
    });
  });

  // ==========================================================================
  // Orchestrator Binding Tests
  // ==========================================================================

  describe('createReviewerModuleBinding', () => {
    it('creates binding with correct key', () => {
      const binding = createReviewerModuleBinding();
      expect(binding.key).toBe('reviewer-technical');
    });

    it('creates input from state', () => {
      const binding = createReviewerModuleBinding();
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      // For testing, call with minimal context
      const context = {} as Parameters<typeof binding.createInput>[1];
      const input = binding.createInput(state, context) as ReviewRequest;
      expect(input.research).toEqual(mockResearch);
      expect(input.planning).toEqual(mockPlanning);
      expect(input.seo).toEqual(mockSeo);
      expect(input.draft).toEqual(mockDraft);
    });

    it('applies output to state correctly', () => {
      const binding = createReviewerModuleBinding();
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      const context = {} as Parameters<typeof binding.applyOutput>[2];
      const newState = binding.applyOutput(state, validReviewResult, context);
      expect(newState.review?.technical).toBeDefined();
      expect(newState.review?.technical?.passed).toBe(true);
    });

    it('preserves runId when applying output', () => {
      const binding = createReviewerModuleBinding();
      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      const context = {} as Parameters<typeof binding.applyOutput>[2];
      const newState = binding.applyOutput(state, validReviewResult, context);
      expect(newState.metadata.runId).toBe(state.metadata.runId);
    });
  });

  // ==========================================================================
  // Module Execution Tests
  // ==========================================================================

  describe('module execution', () => {
    it('executes successfully with valid input', async () => {
      const module = createReviewerModule();
      registerReviewerModule(registry, module);

      mockLLMProvider.setNextResult({
        text: JSON.stringify(validReviewResult),
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0.02,
        pricingVerifiedAt: '2024-01-01',
        providerName: 'anthropic',
        modelId: 'claude-3-opus',
        stopReason: 'complete',
      });

      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      const result = await runner.run(module, validReviewRequest, state, services);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output.overallScore).toBe(75);
      }
    });

    it('records cost on success', async () => {
      const module = createReviewerModule();
      registerReviewerModule(registry, module);

      mockLLMProvider.setNextResult({
        text: JSON.stringify(validReviewResult),
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0.02,
        pricingVerifiedAt: '2024-01-01',
        providerName: 'anthropic',
        modelId: 'claude-3-opus',
        stopReason: 'complete',
      });

      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      const result = await runner.run(module, validReviewRequest, state, services);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.metrics.costEvents).toHaveLength(1);
        const costEvent = result.state.metrics.costEvents[0];
        expect(costEvent).toBeDefined();
        if (costEvent) {
          expect(costEvent.outcome).toBe('success');
        }
      }
    });

    it('records cost on validation error', async () => {
      const module = createReviewerModule();
      registerReviewerModule(registry, module);

      mockLLMProvider.setNextResult({
        text: JSON.stringify({ invalid: 'result' }),
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd: 0.02,
        pricingVerifiedAt: '2024-01-01',
        providerName: 'anthropic',
        modelId: 'claude-3-opus',
        stopReason: 'complete',
      });

      const state: PipelineState = {
        ...createInitialState(),
        research: mockResearch,
        planning: mockPlanning,
        seo: mockSeo,
        draft: mockDraft,
      };

      const result = await runner.run(module, validReviewRequest, state, services);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.state.metrics.costEvents).toHaveLength(1);
        const costEvent = result.state.metrics.costEvents[0];
        expect(costEvent).toBeDefined();
        if (costEvent) {
          expect(costEvent.outcome).toBe('validationError');
        }
      }
    });
  });

  // ==========================================================================
  // Normalize Request Tests
  // ==========================================================================

  describe('normalizeReviewerRequest', () => {
    it('returns frozen object', () => {
      const normalized = normalizeReviewerRequest(validReviewRequest);
      expect(Object.isFrozen(normalized)).toBe(true);
    });

    it('preserves all input data', () => {
      const normalized = normalizeReviewerRequest(validReviewRequest);
      expect(normalized.research).toEqual(mockResearch);
      expect(normalized.planning).toEqual(mockPlanning);
      expect(normalized.seo).toEqual(mockSeo);
      expect(normalized.draft).toEqual(mockDraft);
    });

    it('throws ValidationError for invalid input', () => {
      const invalidRequest = {
        ...validReviewRequest,
        research: undefined,
      } as unknown as ReviewRequest;
      expect(() => normalizeReviewerRequest(invalidRequest)).toThrow(ValidationError);
    });
  });

  // ==========================================================================
  // JSON Schema Tests
  // ==========================================================================

  describe('ReviewResultJsonSchema', () => {
    it('is a valid JSON Schema object', () => {
      const schema = ReviewResultJsonSchema as Record<string, unknown>;
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
      expect(Array.isArray(schema['required'])).toBe(true);
    });

    it('includes all required properties', () => {
      const schema = ReviewResultJsonSchema as Record<string, unknown>;
      const required = schema['required'] as string[];
      expect(required).toContain('overallScore');
      expect(required).toContain('reviewerSummary');
      expect(required).toContain('criticalIssues');
      expect(required).toContain('warningIssues');
    });
  });
});
