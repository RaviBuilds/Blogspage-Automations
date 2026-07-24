/** Tests for the provider-agnostic SEO Optimizer module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ProviderError, ValidationError } from '@/core/errors.js';
import {
  createModuleRegistry,
  defineModule,
  ModuleRunner,
  type ModuleMetadata,
  type ModuleRunnerClock,
  type PipelineModule,
} from '@/core/moduleRunner.js';
import {
  PipelineOrchestrator,
  type OrchestratorModuleBinding,
  type PipelineStateCheckpointStore,
} from '@/core/orchestrator.js';
import {
  BriefSchema,
  createInitialState,
  PlanningSectionSchema,
  ResearchSectionSchema,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptRegistry } from '@/prompts/registry.js';

import {
  buildSEORequest,
  createSEOOptimizerModule,
  createSEOOptimizerModuleBinding,
  normalizeSEORequest,
  SEORequestSchema,
  SEOResultSchema,
  registerSEOOptimizerModule,
  toSeoSection,
  type SEOOptimizerModuleServices,
  type SEOResult,
} from '../seoOptimizerModule.js';

const RESULT: SEOResult = {
  seoTitle: 'The Real Cost of OTA Commission on Independent Hotel Margin',
  seoTitleAlternatives: [
    'The Real Cost of OTA Commission on Independent Hotel Margin',
    'Why Direct Booking Beats OTAs for Independent Hotels',
    "How a Live Room Matrix Fixes Independent Hotels' Double-Booking Problem",
  ],
  metaTitle: 'The Real Cost of OTA Commission for Independent Hotels',
  metaDescription:
    'See how OTA commission reduces independent hotel margin and how a direct booking engine with live inventory can protect it.',
  primaryKeyword: 'OTA commission for independent hotels',
  primaryKeywordConfirmation:
    'Confirmed as the primary keyword because it matches the planned angle and commercial-investigation search intent.',
  secondaryKeywordStrategy: [
    {
      keyword: 'direct booking engine',
      role: 'supporting',
      placement: 'H2 covering the direct-booking mechanism',
      rationale: 'Names the concrete fix the article recommends.',
    },
    {
      keyword: 'hotel room matrix',
      role: 'semantic',
      placement: 'Body copy near the inventory-risk section',
      rationale: 'Reinforces the technical mechanism without repeating the primary keyword.',
    },
  ],
  semanticKeywordClusters: [
    {
      topic: 'OTA commission cost',
      keywords: ['OTA commission rate', 'booking commission fees'],
      intent: 'Informational with commercial investigation',
    },
  ],
  nlpEntities: [{ name: 'OTA', type: 'Industry term', relevance: 'high' }],
  longTailKeywordOpportunities: [
    {
      keyword: 'how much commission do hotels pay OTAs',
      intent: 'Informational',
      rationale: 'Directly matches a question users ask that the outline already answers.',
    },
  ],
  searchIntentValidation: {
    validatedIntent: 'Informational with commercial investigation',
    matchesResearchIntent: true,
    rationale: 'Matches the research module intent and the outline evaluates a specific fix.',
  },
  featuredSnippetOpportunities: [
    {
      query: 'how much commission do OTAs charge hotels',
      format: 'paragraph',
      recommendedAnswerAngle: 'Open the commission section with a direct one-sentence answer.',
    },
  ],
  peopleAlsoAskCoverage: [
    {
      question: 'How much commission do OTAs charge hotels?',
      coverageStatus: 'covered',
      placement: 'The Commission Problem, in Real Numbers',
    },
  ],
  faqOptimizationRecommendations: [
    {
      question: 'What percentage commission do OTAs charge hotels?',
      answerGuidance: 'State the general 15-30% range and note it varies by market and contract.',
      includeInFaqSchema: true,
    },
  ],
  headingOptimizationGuidance: [
    {
      heading: 'The Real Cost of OTA Commission on Independent Hotel Margin',
      level: 1,
      recommendation: 'Keep the primary keyword near the start of the H1.',
      keywordPlacement: 'Primary keyword in the first half of the H1.',
    },
  ],
  urlSlugValidation: {
    slug: 'ota-commission-independent-hotels-direct-booking',
    isValid: true,
    rationale: 'Lowercase, hyphenated, and contains the primary keyword.',
  },
  canonicalRecommendation: {
    recommendation: 'Use the final published URL as its own canonical.',
    rationale: 'This is a new, single-published-location article.',
  },
  internalLinkingStrategy: {
    anchorThemes: ['hotel direct booking technology', 'hotel revenue management fundamentals'],
    implementationGuidance: 'Link to relevant existing posts once the writer confirms inventory.',
  },
  externalAuthorityRecommendations: [
    {
      sourceType: 'Recognized hospitality industry research publication',
      recommendation: 'Cite general commission-range figures to a credible source.',
      rationale: 'Supports the commission claim without overstating precision.',
    },
  ],
  suggestedSchemaTypes: [
    { type: 'Article', rationale: 'Standard structured data for a long-form article.' },
    { type: 'FAQ', rationale: 'The FAQ recommendations are strong FAQPage candidates.' },
  ],
  localBusinessApplicability: {
    applicable: false,
    rationale: 'This article targets hotel operators broadly, not one physical location.',
  },
  imageAltTextGuidance: {
    patterns: ['Describe the specific hotel-operations scene shown'],
    avoid: ['Generic alt text like "hotel image"'],
    requiredContext: 'Alt text should reflect the direct-booking scene actually depicted.',
  },
  imageFilenameGuidance: {
    pattern: 'lowercase-hyphenated-descriptive-filename.jpg',
    examples: ['direct-booking-engine-dashboard.jpg'],
  },
  eeatRecommendations: [
    {
      recommendation: 'Attribute commission-range claims to a named category of industry source.',
      evidenceType: 'Cited industry benchmark',
    },
  ],
  readabilityTargets: {
    targetReadingLevel: 'Intermediate',
    targetSentenceLengthWords: 18,
    targetParagraphLengthSentences: 4,
    guidance: 'Keep sentences direct and avoid stacking multiple qualifiers.',
  },
  contentGapRecommendations: [
    {
      gap: 'Competitors rarely name a concrete technical fix.',
      opportunity: 'Give the room-matrix mechanism its own detailed section.',
      priority: 'high',
    },
  ],
  keywordPlacementRecommendations: [
    {
      location: 'First 100 words',
      keyword: 'OTA commission for independent hotels',
      recommendation: 'Introduce the primary keyword naturally in the opening paragraph.',
    },
  ],
  seoScore: 82,
};

const RESEARCH: ResearchSection = {
  keyFacts: [
    'OTA commissions run 15-30% per booking.',
    'A live room matrix reduces double-booking risk.',
    'Direct-booked guests return more often.',
  ],
  suggestedAngle: 'Frame OTA commission as a recurring tax on margin.',
  competitorGapNotes: ['Most OTA commission explainers omit a concrete technical fix.'],
  candidateStatistics: [
    {
      claim: 'OTA commissions commonly fall in the 15-30% range.',
      informalSource: 'industry benchmark reports',
    },
  ],
} as const;

const PLANNING: PlanningSection = {
  titleCandidates: [
    'The Real Cost of OTA Commission on Independent Hotel Margin',
    'Why Direct Booking Beats OTAs for Independent Hotels',
    "How a Live Room Matrix Fixes Independent Hotels' Double-Booking Problem",
  ],
  outline: [
    {
      heading: 'The Commission Problem, in Real Numbers',
      level: 2,
      talkingPoints: ['Quantify the 15-30% commission range as a recurring cost.'],
    },
    {
      heading: 'What a Direct Booking Engine With a Live Room Matrix Does',
      level: 2,
      talkingPoints: ['Describe the room and rate matrix as an operational mechanism.'],
    },
  ],
  targetWordCount: 1_400,
  angle: 'OTA commission is a recurring tax on margin; a direct booking engine is the fix.',
} as const;

class FakeClock implements ModuleRunnerClock {
  private wallIndex = 0;
  private monotonicIndex = 0;

  public constructor(
    private readonly wallTimes: readonly string[] = [
      '2026-07-24T15:00:00.000Z',
      '2026-07-24T15:00:00.020Z',
      '2026-07-24T15:00:00.040Z',
      '2026-07-24T15:00:00.060Z',
      '2026-07-24T15:00:00.080Z',
      '2026-07-24T15:00:00.100Z',
      '2026-07-24T15:00:00.120Z',
      '2026-07-24T15:00:00.140Z',
    ],
    private readonly monotonicTimes: readonly number[] = [100, 120, 200, 220, 300, 320, 400, 420],
  ) {}

  public now(): Date {
    const value = this.wallTimes[this.wallIndex];
    this.wallIndex += 1;
    if (value === undefined) {
      throw new Error('FakeClock has no remaining wall-clock values.');
    }
    return new Date(value);
  }

  public monotonicNow(): number {
    const value = this.monotonicTimes[this.monotonicIndex];
    this.monotonicIndex += 1;
    if (value === undefined) {
      throw new Error('FakeClock has no remaining monotonic values.');
    }
    return value;
  }
}

class MemoryStateStore implements PipelineStateCheckpointStore {
  public readonly states: PipelineState[] = [];

  public save(state: PipelineState): Promise<void> {
    this.states.push(state);
    return Promise.resolve();
  }
}

function createPromptRegistry(calls: Readonly<Record<string, string>>[] = []): PromptRegistry {
  return {
    get: (_key, variables) => {
      calls.push(variables);
      return Promise.resolve({
        system: 'SEO Optimizer system prompt',
        user: 'SEO Optimizer user prompt',
        promptVersion: 'ghi9012',
      });
    },
  };
}

function createServices(
  response: string = JSON.stringify(RESULT),
  jsonSchema = true,
  promptCalls: Readonly<Record<string, string>>[] = [],
): SEOOptimizerModuleServices {
  return {
    promptRegistry: createPromptRegistry(promptCalls),
    llmProvider: new FakeLLMProvider({
      text: response,
      capabilities: { vision: false, jsonSchema, caching: false, reasoning: false },
      providerName: 'openai',
      modelId: 'gpt-5.6-terra',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 220, outputTokens: 480, cachedInputTokens: 8, reasoningTokens: 16 },
      costUsd: 0.031,
    }),
  };
}

function createState(): PipelineState {
  const state = createInitialState({ sheetRowId: 'row-1' });
  return {
    ...state,
    brief: {
      topic: 'Why independent hotels lose margin to OTAs',
      targetAudience: 'Independent hotel owners and revenue managers',
      keywordHints: ['direct booking', 'direct booking', ' OTA commission '],
      constraints: ['Keep statistics generic', 'Keep statistics generic'],
      sheetRowId: 'row-1',
    },
    research: RESEARCH,
    planning: PLANNING,
  };
}

function sheetReaderModule(): PipelineModule<
  undefined,
  PipelineState['brief'],
  SEOOptimizerModuleServices
> {
  const metadata: ModuleMetadata = {
    key: 'sheet-reader',
    displayName: 'Sheet Reader Test Double',
    description: 'Supplies a brief for SEO Optimizer orchestration testing.',
    dependencies: [],
    capabilities: { requires: [], provides: ['brief'] },
  };

  return defineModule({
    metadata,
    execute: (_input, context) => context.state.brief,
  });
}

function sheetReaderBinding(): OrchestratorModuleBinding<SEOOptimizerModuleServices> {
  return {
    key: 'sheet-reader',
    createInput: () => undefined,
    applyOutput: (state, output) => {
      const brief = BriefSchema.safeParse(output);
      if (!brief.success) {
        throw new ValidationError('sheet-reader', ['A valid brief is required.']);
      }
      return {
        ...state,
        metadata: { ...state.metadata, sheetRowId: brief.data.sheetRowId },
        brief: brief.data,
      };
    },
  };
}

function researchModule(): PipelineModule<undefined, ResearchSection, SEOOptimizerModuleServices> {
  const metadata: ModuleMetadata = {
    key: 'research',
    displayName: 'Research Test Double',
    description: 'Supplies structured research for SEO Optimizer orchestration testing.',
    dependencies: ['sheet-reader'],
    capabilities: { requires: ['brief'], provides: ['research.structured-output'] },
  };

  return defineModule({
    metadata,
    execute: () => RESEARCH,
  });
}

function researchBinding(): OrchestratorModuleBinding<SEOOptimizerModuleServices> {
  return {
    key: 'research',
    createInput: () => undefined,
    applyOutput: (state, output) => {
      const research = ResearchSectionSchema.safeParse(output);
      if (!research.success) {
        throw new ValidationError('research', ['Valid structured research is required.']);
      }
      return { ...state, research: research.data };
    },
  };
}

function plannerModule(): PipelineModule<undefined, PlanningSection, SEOOptimizerModuleServices> {
  const metadata: ModuleMetadata = {
    key: 'planner',
    displayName: 'Content Planner Test Double',
    description: 'Supplies a content plan for SEO Optimizer orchestration testing.',
    dependencies: ['sheet-reader', 'research'],
    capabilities: { requires: ['research.structured-output'], provides: ['planner.content-plan'] },
  };

  return defineModule({
    metadata,
    execute: () => PLANNING,
  });
}

function plannerBinding(): OrchestratorModuleBinding<SEOOptimizerModuleServices> {
  return {
    key: 'planner',
    createInput: () => undefined,
    applyOutput: (state, output) => {
      const planning = PlanningSectionSchema.safeParse(output);
      if (!planning.success) {
        throw new ValidationError('planner', ['A valid content plan is required.']);
      }
      return { ...state, planning: planning.data };
    },
  };
}

describe('SEO Optimizer contracts', () => {
  it('normalizes brief, research, and planning inputs into a frozen deterministic request', () => {
    const request = buildSEORequest(createState());

    expect(request).toEqual({
      topic: 'Why independent hotels lose margin to OTAs',
      targetAudience: 'Independent hotel owners and revenue managers',
      keywordHints: ['direct booking', 'OTA commission'],
      constraints: ['Keep statistics generic'],
      research: RESEARCH,
      planning: PLANNING,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.keywordHints)).toBe(true);
    expect(Object.isFrozen(request.research)).toBe(true);
    expect(Object.isFrozen(request.planning)).toBe(true);
    expect(() => buildSEORequest(createInitialState())).toThrow(ValidationError);
    expect(() => {
      const state = createState();
      return buildSEORequest({ ...state, research: undefined });
    }).toThrow(ValidationError);
    expect(() => {
      const state = createState();
      return buildSEORequest({ ...state, planning: undefined });
    }).toThrow(ValidationError);
    expect(() =>
      normalizeSEORequest({
        topic: ' ',
        targetAudience: 'Audience',
        keywordHints: [],
        constraints: [],
        research: RESEARCH,
        planning: PLANNING,
      }),
    ).toThrow(ValidationError);
  });

  it('validates the complete strict public result contract and SEO invariants', () => {
    expect(SEORequestSchema.parse(buildSEORequest(createState()))).toEqual(
      buildSEORequest(createState()),
    );
    expect(SEOResultSchema.parse(RESULT)).toEqual(RESULT);
    expect(SEOResultSchema.safeParse({ ...RESULT, unownedProperty: true }).success).toBe(false);
    expect(
      SEOResultSchema.safeParse({
        ...RESULT,
        seoTitleAlternatives: [RESULT.seoTitleAlternatives[0], RESULT.seoTitleAlternatives[0]],
      }).success,
    ).toBe(false);
    expect(
      SEOResultSchema.safeParse({
        ...RESULT,
        seoTitle: 'A title absent from the alternatives list',
      }).success,
    ).toBe(false);
    expect(
      SEOResultSchema.safeParse({
        ...RESULT,
        suggestedSchemaTypes: [{ type: 'FAQ', rationale: 'No Article entry present.' }],
      }).success,
    ).toBe(false);
    expect(
      SEOResultSchema.safeParse({
        ...RESULT,
        localBusinessApplicability: {
          applicable: true,
          rationale: 'Serves one physical location.',
        },
      }).success,
    ).toBe(false);
    expect(
      SEOResultSchema.safeParse({
        ...RESULT,
        localBusinessApplicability: {
          applicable: true,
          rationale: 'Serves one physical location.',
        },
        suggestedSchemaTypes: [
          ...RESULT.suggestedSchemaTypes,
          { type: 'LocalBusiness', rationale: 'Applicable.' },
        ],
      }).success,
    ).toBe(true);
  });

  it('projects the rich result into the frozen, minimal PipelineState SeoSection', () => {
    const section = toSeoSection(RESULT);

    expect(section).toEqual({
      focusKeyword: RESULT.primaryKeyword,
      seoKeywords: [
        RESULT.primaryKeyword,
        ...RESULT.secondaryKeywordStrategy.map((strategy) => strategy.keyword),
      ],
      seoTitleDraft: RESULT.seoTitle,
      metaDescriptionDraft: RESULT.metaDescription,
      internalLinkTargets: [],
    });
  });
});

describe('SEO Optimizer execution', () => {
  it('executes only through ModuleRunner, resolves the registered prompt, and records cost', async () => {
    const promptCalls: Readonly<Record<string, string>>[] = [];
    const services = createServices(JSON.stringify(RESULT), true, promptCalls);
    const module = createSEOOptimizerModule();
    const registry = createModuleRegistry<SEOOptimizerModuleServices>().register(module);
    const runner = new ModuleRunner({ registry, clock: new FakeClock() });
    const state = createState();

    const result = await runner.run(module, buildSEORequest(state), state, services);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output).toEqual(RESULT);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.secondaryKeywordStrategy)).toBe(true);
    expect(Object.isFrozen(result.output.secondaryKeywordStrategy[0])).toBe(true);
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({
      topic: 'Why independent hotels lose margin to OTAs',
      targetAudience: 'Independent hotel owners and revenue managers',
      plannedAngle: PLANNING.angle,
    });
    const provider = services.llmProvider as FakeLLMProvider;
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      moduleKey: 'seo-planner',
      systemPrompt: 'SEO Optimizer system prompt',
      userPrompt: 'SEO Optimizer user prompt',
      responseFormat: 'json',
      maxOutputTokens: 3200,
    });
    expect(provider.calls[0]?.jsonSchema).toBeDefined();
    expect(result.state.metrics.costEvents).toEqual([
      {
        runId: state.metadata.runId,
        moduleKey: 'seo-planner',
        attemptNumber: 1,
        timestamp: '2026-07-24T15:00:00.000Z',
        provider: 'openai',
        modelId: 'gpt-5.6-terra',
        promptVersion: 'ghi9012',
        inputTokens: 220,
        outputTokens: 480,
        cachedInputTokens: 8,
        reasoningTokens: 16,
        estimatedCostUsd: 0.031,
        pricingVerifiedAt: '2026-07-01',
        latencyMs: 20,
        outcome: 'success',
        isImageGeneration: false,
      },
    ]);
    expect(result.state.metrics.totalCostUsd).toBeCloseTo(0.031);
    expect(result.state.timings).toHaveLength(1);
    expect(state.metrics.costEvents).toEqual([]);
    expect(state.timings).toEqual([]);
  });

  it('falls back to local JSON parsing when the provider lacks JSON-schema support', async () => {
    const services = createServices(JSON.stringify(RESULT), false);
    const module = createSEOOptimizerModule();
    const registry = createModuleRegistry<SEOOptimizerModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildSEORequest(createState()),
      createState(),
      services,
    );

    expect(result.ok).toBe(true);
    expect((services.llmProvider as FakeLLMProvider).calls[0]?.jsonSchema).toBeUndefined();
  });

  it('returns a typed validation failure and validation cost event for malformed provider output', async () => {
    const services = createServices('{"not":"the expected schema"}');
    const module = createSEOOptimizerModule();
    const state = createState();
    const registry = createModuleRegistry<SEOOptimizerModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildSEORequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(result.state.metrics.costEvents[0]?.outcome).toBe('validationError');
    expect(result.state.errors[0]?.errorClass).toBe('ValidationError');
  });

  it('preserves provider errors without provider-specific handling in the module', async () => {
    const providerError = new ProviderError('seo-planner', 'openai', 503, true);
    const services: SEOOptimizerModuleServices = {
      promptRegistry: createPromptRegistry(),
      llmProvider: new FakeLLMProvider({ throws: providerError }),
    };
    const module = createSEOOptimizerModule();
    const state = createState();
    const registry = createModuleRegistry<SEOOptimizerModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildSEORequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(providerError);
      expect(result.state.metrics.costEvents).toEqual([]);
    }
  });
});

describe('SEO Optimizer registry and orchestrator compatibility', () => {
  it('declares frozen dependencies and capabilities and registers independently', () => {
    const registry = createModuleRegistry<SEOOptimizerModuleServices>();
    registerSEOOptimizerModule(registry);

    const module = registry.require('seo-planner');
    expect(module.metadata.dependencies).toEqual(['sheet-reader', 'research', 'planner']);
    expect(module.metadata.capabilities).toEqual({
      requires: [
        'llm.complete',
        'prompt-registry.get',
        'research.structured-output',
        'planner.content-plan',
      ],
      provides: ['seo.strategy', 'seo.state-projection'],
    });
    expect(Object.isFrozen(module.metadata)).toBe(true);
    expect(() => registerSEOOptimizerModule(registry)).toThrow(/already registered/);
  });

  it('executes through PipelineOrchestrator and projects only the frozen SEO state', async () => {
    const services = createServices();
    const seoOptimizer = createSEOOptimizerModule();
    const sheetReader = sheetReaderModule();
    const research = researchModule();
    const planner = plannerModule();
    const registry = createModuleRegistry<SEOOptimizerModuleServices>()
      .register(seoOptimizer)
      .register(research)
      .register(planner)
      .register(sheetReader);
    const store = new MemoryStateStore();
    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry, clock: new FakeClock() }),
      stateStore: store,
      services,
      bindings: [
        sheetReaderBinding(),
        researchBinding(),
        plannerBinding(),
        createSEOOptimizerModuleBinding(),
      ],
    });
    const initialState = createState();

    const result = await orchestrator.execute(initialState);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(orchestrator.executionOrder()).toEqual([
      'sheet-reader',
      'research',
      'planner',
      'seo-planner',
    ]);
    expect(result.state.seo).toEqual(toSeoSection(RESULT));
    expect(result.state.metadata.runId).toBe(initialState.metadata.runId);
    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(initialState.seo).toBeUndefined();
    expect(store.states).toHaveLength(6);
  });
});
