/** Tests for the provider-agnostic Content Planner module and its pipeline adapters. */

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
  ResearchSectionSchema,
  type PipelineState,
  type ResearchSection,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptRegistry } from '@/prompts/registry.js';

import {
  buildPlannerRequest,
  createPlannerModule,
  createPlannerModuleBinding,
  normalizePlannerRequest,
  PlannerRequestSchema,
  PlannerResultSchema,
  registerPlannerModule,
  type PlannerModuleServices,
  type PlannerResult,
} from '../plannerModule.js';

const RESULT: PlannerResult = {
  titleCandidates: [
    'How Immutable Pipeline State Makes Content Automation Reliable',
    'The Practical Guide to Immutable State in Content Pipelines',
    'Build Resumable Content Pipelines With Immutable State',
  ],
  recommendedTitle: 'Build Resumable Content Pipelines With Immutable State',
  metaTitle: 'Build Resumable Content Pipelines With Immutable State',
  metaDescriptionDraft:
    'Learn how immutable pipeline state makes content automation auditable, resumable, and easier to operate.',
  articleGoal: 'Help platform engineers design reliable content automation workflows.',
  readerPersona: 'Platform engineers responsible for content automation reliability.',
  searchIntent: 'Informational',
  primaryKeyword: 'immutable pipeline state',
  secondaryKeywords: ['resumable pipelines', 'workflow checkpointing'],
  suggestedUrlSlug: 'immutable-pipeline-state-content-automation',
  recommendedArticleLength: 1_600,
  readingLevel: 'Intermediate',
  toneOfVoice: 'Practical, precise, and technically grounded.',
  articleStructure: 'Problem-solution guide with an implementation-oriented conclusion.',
  outline: [
    {
      heading: 'Build Resumable Content Pipelines With Immutable State',
      level: 1,
      sectionGoal: 'Frame immutable state as the article promise and technical foundation.',
      talkingPoints: ['Define immutable pipeline state and the operational problem it solves.'],
    },
    {
      heading: 'Why Mutable Workflow State Makes Failures Harder to Diagnose',
      level: 2,
      sectionGoal: 'Establish the operational cost of in-place workflow mutation.',
      talkingPoints: ['Show how mutated state hides the transition that introduced a failure.'],
    },
    {
      heading: 'How Immutable Snapshots Enable Reliable Resume Boundaries',
      level: 2,
      sectionGoal: 'Explain how checkpointed snapshots create auditable retry boundaries.',
      talkingPoints: ['Connect append-only timing records to deterministic execution history.'],
    },
    {
      heading: 'Designing Module Contracts That Stay Provider Agnostic',
      level: 2,
      sectionGoal: 'Show how strict module contracts avoid downstream provider coupling.',
      talkingPoints: [
        'Explain why providers should return typed output through a narrow abstraction.',
      ],
    },
    {
      heading: 'A Practical Implementation Checklist',
      level: 2,
      sectionGoal: 'Give readers an actionable next step for their own pipeline.',
      talkingPoints: ['List the state ownership and validation decisions to establish first.'],
    },
  ],
  internalLinkingOpportunities: [
    {
      anchorText: 'workflow checkpointing patterns',
      targetTopic: 'Reliable workflow checkpointing patterns',
      rationale: 'Provides a deeper implementation guide for the resume boundary discussion.',
    },
  ],
  externalReferenceSuggestions: [
    {
      title: 'Distributed Systems Reliability Patterns',
      source: 'Engineering documentation',
      rationale: 'Supports the durability and auditability rationale with established patterns.',
    },
  ],
  faqCandidates: [
    {
      question: 'What is immutable pipeline state?',
      answerDirection: 'Define it as append-only snapshots rather than in-place state mutation.',
    },
  ],
  ctaRecommendation: 'Audit one workflow and identify its first immutable checkpoint boundary.',
  authorNotes: ['Use a concrete failure-and-resume example rather than abstract theory.'],
  contentConstraints: ['Use precise language', 'Avoid provider-specific implementation details'],
  angle: 'Immutable state is the practical foundation for reliable, resumable content automation.',
};

const RESEARCH: ResearchSection = {
  keyFacts: [
    'Immutable state snapshots make retry boundaries auditable.',
    'Append-only timing records retain a deterministic execution history.',
    'A module-specific output contract prevents downstream provider coupling.',
  ],
  suggestedAngle: 'Frame immutable state as the practical foundation for reliable automation.',
  competitorGapNotes: ['Generic workflow guides omit immutable checkpoint recovery.'],
  candidateStatistics: [
    {
      claim: 'Checkpointed jobs can resume without rerunning completed work.',
      informalSource: 'workflow orchestration engineering guidance',
    },
  ],
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
    ],
    private readonly monotonicTimes: readonly number[] = [100, 120, 200, 220, 300, 320],
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
        system: 'Planner system prompt',
        user: 'Planner user prompt',
        promptVersion: 'def5678',
      });
    },
  };
}

function createServices(
  response: string = JSON.stringify(RESULT),
  jsonSchema = true,
  promptCalls: Readonly<Record<string, string>>[] = [],
): PlannerModuleServices {
  return {
    promptRegistry: createPromptRegistry(promptCalls),
    llmProvider: new FakeLLMProvider({
      text: response,
      capabilities: { vision: false, jsonSchema, caching: false, reasoning: false },
      providerName: 'openai',
      modelId: 'gpt-5.6-terra',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 180, outputTokens: 320, cachedInputTokens: 6, reasoningTokens: 12 },
      costUsd: 0.022,
    }),
  };
}

function createState(): PipelineState {
  const state = createInitialState({ sheetRowId: 'row-1' });
  return {
    ...state,
    brief: {
      topic: 'Immutable pipeline state',
      targetAudience: 'Platform engineers',
      keywordHints: ['immutable pipeline state', 'immutable pipeline state', ' recovery '],
      constraints: ['Use precise language', 'Use precise language'],
      sheetRowId: 'row-1',
    },
    research: RESEARCH,
  };
}

function sheetReaderModule(): PipelineModule<
  undefined,
  PipelineState['brief'],
  PlannerModuleServices
> {
  const metadata: ModuleMetadata = {
    key: 'sheet-reader',
    displayName: 'Sheet Reader Test Double',
    description: 'Supplies a brief for Content Planner orchestration testing.',
    dependencies: [],
    capabilities: { requires: [], provides: ['brief'] },
  };

  return defineModule({
    metadata,
    execute: (_input, context) => context.state.brief,
  });
}

function sheetReaderBinding(): OrchestratorModuleBinding<PlannerModuleServices> {
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

function researchModule(): PipelineModule<undefined, ResearchSection, PlannerModuleServices> {
  const metadata: ModuleMetadata = {
    key: 'research',
    displayName: 'Research Test Double',
    description: 'Supplies structured research for Content Planner orchestration testing.',
    dependencies: ['sheet-reader'],
    capabilities: { requires: ['brief'], provides: ['research.structured-output'] },
  };

  return defineModule({
    metadata,
    execute: () => RESEARCH,
  });
}

function researchBinding(): OrchestratorModuleBinding<PlannerModuleServices> {
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

describe('Content Planner contracts', () => {
  it('normalizes brief and research inputs into a frozen deterministic request', () => {
    const request = buildPlannerRequest(createState());

    expect(request).toEqual({
      topic: 'Immutable pipeline state',
      targetAudience: 'Platform engineers',
      keywordHints: ['immutable pipeline state', 'recovery'],
      constraints: ['Use precise language'],
      research: RESEARCH,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.keywordHints)).toBe(true);
    expect(Object.isFrozen(request.research)).toBe(true);
    expect(() => buildPlannerRequest(createInitialState())).toThrow(ValidationError);
    expect(() =>
      normalizePlannerRequest({
        topic: ' ',
        targetAudience: 'Audience',
        keywordHints: [],
        constraints: [],
        research: RESEARCH,
      }),
    ).toThrow(ValidationError);
    expect(() => {
      const state = createState();
      return buildPlannerRequest({ ...state, research: undefined });
    }).toThrow(ValidationError);
  });

  it('validates the complete strict public result contract and planning invariants', () => {
    expect(PlannerRequestSchema.parse(buildPlannerRequest(createState()))).toEqual(
      buildPlannerRequest(createState()),
    );
    expect(PlannerResultSchema.parse(RESULT)).toEqual(RESULT);
    expect(PlannerResultSchema.safeParse({ ...RESULT, unownedProperty: true }).success).toBe(false);
    expect(
      PlannerResultSchema.safeParse({
        ...RESULT,
        titleCandidates: RESULT.titleCandidates.slice(0, 2),
      }).success,
    ).toBe(false);
    expect(
      PlannerResultSchema.safeParse({
        ...RESULT,
        recommendedTitle: 'A title absent from the candidate list',
      }).success,
    ).toBe(false);
    expect(
      PlannerResultSchema.safeParse({
        ...RESULT,
        outline: RESULT.outline.map((item) => (item.level === 2 ? { ...item, level: 3 } : item)),
      }).success,
    ).toBe(false);
  });
});

describe('Content Planner execution', () => {
  it('executes only through ModuleRunner, resolves the registered prompt, and records cost', async () => {
    const promptCalls: Readonly<Record<string, string>>[] = [];
    const services = createServices(JSON.stringify(RESULT), true, promptCalls);
    const module = createPlannerModule();
    const registry = createModuleRegistry<PlannerModuleServices>().register(module);
    const runner = new ModuleRunner({ registry, clock: new FakeClock() });
    const state = createState();

    const result = await runner.run(module, buildPlannerRequest(state), state, services);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output).toEqual(RESULT);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.outline)).toBe(true);
    expect(Object.isFrozen(result.output.outline[0])).toBe(true);
    expect(promptCalls).toEqual([
      {
        topic: 'Immutable pipeline state',
        targetAudience: 'Platform engineers',
        suggestedAngle: RESEARCH.suggestedAngle,
        keyFactsAsMarkdownList: RESEARCH.keyFacts.map((fact) => `- ${fact}`).join('\n'),
      },
    ]);
    const provider = services.llmProvider as FakeLLMProvider;
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      moduleKey: 'planner',
      systemPrompt: 'Planner system prompt',
      userPrompt: 'Planner user prompt',
      responseFormat: 'json',
      maxOutputTokens: 2400,
    });
    expect(provider.calls[0]?.jsonSchema).toBeDefined();
    expect(result.state.metrics.costEvents).toEqual([
      {
        runId: state.metadata.runId,
        moduleKey: 'planner',
        attemptNumber: 1,
        timestamp: '2026-07-24T15:00:00.000Z',
        provider: 'openai',
        modelId: 'gpt-5.6-terra',
        promptVersion: 'def5678',
        inputTokens: 180,
        outputTokens: 320,
        cachedInputTokens: 6,
        reasoningTokens: 12,
        estimatedCostUsd: 0.022,
        pricingVerifiedAt: '2026-07-01',
        latencyMs: 20,
        outcome: 'success',
        isImageGeneration: false,
      },
    ]);
    expect(result.state.metrics.totalCostUsd).toBeCloseTo(0.022);
    expect(result.state.timings).toHaveLength(1);
    expect(state.metrics.costEvents).toEqual([]);
    expect(state.timings).toEqual([]);
  });

  it('falls back to local JSON parsing when the provider lacks JSON-schema support', async () => {
    const services = createServices(JSON.stringify(RESULT), false);
    const module = createPlannerModule();
    const registry = createModuleRegistry<PlannerModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPlannerRequest(createState()),
      createState(),
      services,
    );

    expect(result.ok).toBe(true);
    expect((services.llmProvider as FakeLLMProvider).calls[0]?.jsonSchema).toBeUndefined();
  });

  it('returns a typed validation failure and validation cost event for malformed provider output', async () => {
    const services = createServices('{"not":"the expected schema"}');
    const module = createPlannerModule();
    const state = createState();
    const registry = createModuleRegistry<PlannerModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPlannerRequest(state),
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
    const providerError = new ProviderError('planner', 'openai', 503, true);
    const services: PlannerModuleServices = {
      promptRegistry: createPromptRegistry(),
      llmProvider: new FakeLLMProvider({ throws: providerError }),
    };
    const module = createPlannerModule();
    const state = createState();
    const registry = createModuleRegistry<PlannerModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPlannerRequest(state),
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

describe('Content Planner registry and orchestrator compatibility', () => {
  it('declares frozen dependencies and capabilities and registers independently', () => {
    const registry = createModuleRegistry<PlannerModuleServices>();
    registerPlannerModule(registry);

    const module = registry.require('planner');
    expect(module.metadata.dependencies).toEqual(['sheet-reader', 'research']);
    expect(module.metadata.capabilities).toEqual({
      requires: ['llm.complete', 'prompt-registry.get', 'research.structured-output'],
      provides: ['planner.content-plan', 'planner.state-projection'],
    });
    expect(Object.isFrozen(module.metadata)).toBe(true);
    expect(() => registerPlannerModule(registry)).toThrow(/already registered/);
  });

  it('executes through PipelineOrchestrator and projects only the frozen planning state', async () => {
    const services = createServices();
    const planner = createPlannerModule();
    const sheetReader = sheetReaderModule();
    const research = researchModule();
    const registry = createModuleRegistry<PlannerModuleServices>()
      .register(planner)
      .register(research)
      .register(sheetReader);
    const store = new MemoryStateStore();
    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry, clock: new FakeClock() }),
      stateStore: store,
      services,
      bindings: [sheetReaderBinding(), researchBinding(), createPlannerModuleBinding()],
    });
    const initialState = createState();

    const result = await orchestrator.execute(initialState);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(orchestrator.executionOrder()).toEqual(['sheet-reader', 'research', 'planner']);
    expect(result.state.planning).toEqual({
      titleCandidates: RESULT.titleCandidates,
      outline: RESULT.outline.slice(1).map(({ heading, level, talkingPoints }) => ({
        heading,
        level,
        talkingPoints,
      })),
      targetWordCount: RESULT.recommendedArticleLength,
      angle: RESULT.angle,
    });
    expect(result.state.metadata.runId).toBe(initialState.metadata.runId);
    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(initialState.planning).toBeUndefined();
    expect(store.states).toHaveLength(5);
  });
});
