/** Tests for the provider-agnostic Draft Writer module and its pipeline adapters. */

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
  createInitialState,
  PlanningSectionSchema,
  ResearchSectionSchema,
  SeoSectionSchema,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type SeoSection,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptRegistry } from '@/prompts/registry.js';

import {
  buildWriterRequest,
  createDraftWriterModule,
  createDraftWriterModuleBinding,
  normalizeWriterRequest,
  registerDraftWriterModule,
  toDraft,
  WriterRequestSchema,
  WriterResultSchema,
  type DraftWriterModuleServices,
  type WriterResult,
} from '../draftWriterModule.js';

const RESULT: WriterResult = {
  markdown:
    '[[image: Hotel front desk dashboard showing a live room matrix]]\n\n## The Commission Problem, in Real Numbers\n\nEvery booking that arrives through an OTA carries a commission of 15% to 30% off the top, a recurring tax on margin that most independent hotels never renegotiate.\n\n## What a Direct Booking Engine With a Live Room Matrix Does\n\nA live room matrix syncs availability across every channel in real time, closing the gap that manual updates leave open. Read our [[link: guide to hotel revenue management]] for the mechanics.\n\nReady to stop paying OTA commission on every booking? Talk to our team about a direct booking engine built around your property.',
  wordCount: 92,
  linkMarkers: [{ markerId: 'link-1', anchorTextHint: 'guide to hotel revenue management' }],
  imageMarkers: [
    {
      markerId: 'image-1',
      role: 'hero',
      descriptionHint: 'Hotel front desk dashboard showing a live room matrix',
    },
  ],
} as const;

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

const SEO: SeoSection = {
  focusKeyword: 'direct booking hotel',
  seoKeywords: ['direct booking hotel', 'hotel room matrix'],
  seoTitleDraft: 'The Real Cost of OTA Commission on Independent Hotel Margin',
  metaDescriptionDraft:
    'See how OTA commission reduces independent hotel margin and how a direct booking engine with live inventory can protect it.',
  internalLinkTargets: [],
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
        system: 'Draft Writer system prompt',
        user: 'Draft Writer user prompt',
        promptVersion: 'jkl3456',
      });
    },
  };
}

function createServices(
  response: string = JSON.stringify(RESULT),
  jsonSchema = true,
  promptCalls: Readonly<Record<string, string>>[] = [],
): DraftWriterModuleServices {
  return {
    promptRegistry: createPromptRegistry(promptCalls),
    llmProvider: new FakeLLMProvider({
      text: response,
      capabilities: { vision: false, jsonSchema, caching: false, reasoning: false },
      providerName: 'openai',
      modelId: 'gpt-5.6-terra',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 320, outputTokens: 1_800, cachedInputTokens: 10, reasoningTokens: 0 },
      costUsd: 0.084,
    }),
  };
}

function createState(): PipelineState {
  const state = createInitialState({ sheetRowId: 'row-1' });
  return {
    ...state,
    research: RESEARCH,
    planning: PLANNING,
    seo: SEO,
  };
}

function researchModule(): PipelineModule<undefined, ResearchSection, DraftWriterModuleServices> {
  const metadata: ModuleMetadata = {
    key: 'research',
    displayName: 'Research Test Double',
    description: 'Supplies structured research for Draft Writer orchestration testing.',
    dependencies: [],
    capabilities: { requires: [], provides: ['research.structured-output'] },
  };

  return defineModule({
    metadata,
    execute: () => RESEARCH,
  });
}

function researchBinding(): OrchestratorModuleBinding<DraftWriterModuleServices> {
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

function plannerModule(): PipelineModule<undefined, PlanningSection, DraftWriterModuleServices> {
  const metadata: ModuleMetadata = {
    key: 'planner',
    displayName: 'Content Planner Test Double',
    description: 'Supplies a content plan for Draft Writer orchestration testing.',
    dependencies: ['research'],
    capabilities: { requires: ['research.structured-output'], provides: ['planner.content-plan'] },
  };

  return defineModule({
    metadata,
    execute: () => PLANNING,
  });
}

function plannerBinding(): OrchestratorModuleBinding<DraftWriterModuleServices> {
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

function seoModule(): PipelineModule<undefined, SeoSection, DraftWriterModuleServices> {
  const metadata: ModuleMetadata = {
    key: 'seo-planner',
    displayName: 'SEO Optimizer Test Double',
    description: 'Supplies an SEO strategy for Draft Writer orchestration testing.',
    dependencies: ['research', 'planner'],
    capabilities: { requires: ['planner.content-plan'], provides: ['seo.strategy'] },
  };

  return defineModule({
    metadata,
    execute: () => SEO,
  });
}

function seoBinding(): OrchestratorModuleBinding<DraftWriterModuleServices> {
  return {
    key: 'seo-planner',
    createInput: () => undefined,
    applyOutput: (state, output) => {
      const seo = SeoSectionSchema.safeParse(output);
      if (!seo.success) {
        throw new ValidationError('seo-planner', ['A valid SEO strategy is required.']);
      }
      return { ...state, seo: seo.data };
    },
  };
}

describe('Draft Writer contracts', () => {
  it('normalizes research, planning, and SEO inputs into a frozen deterministic request', () => {
    const request = buildWriterRequest(createState());

    expect(request).toEqual({
      research: RESEARCH,
      planning: PLANNING,
      seo: SEO,
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.research)).toBe(true);
    expect(Object.isFrozen(request.planning)).toBe(true);
    expect(Object.isFrozen(request.seo)).toBe(true);
    expect(() => buildWriterRequest(createInitialState())).toThrow(ValidationError);
    expect(() => {
      const state = createState();
      return buildWriterRequest({ ...state, research: undefined });
    }).toThrow(ValidationError);
    expect(() => {
      const state = createState();
      return buildWriterRequest({ ...state, planning: undefined });
    }).toThrow(ValidationError);
    expect(() => {
      const state = createState();
      return buildWriterRequest({ ...state, seo: undefined });
    }).toThrow(ValidationError);
  });

  it('validates the complete strict public result contract and draft invariants', () => {
    expect(WriterRequestSchema.parse(buildWriterRequest(createState()))).toEqual(
      buildWriterRequest(createState()),
    );
    expect(WriterResultSchema.parse(RESULT)).toEqual(RESULT);
    expect(WriterResultSchema.safeParse({ ...RESULT, unownedProperty: true }).success).toBe(false);
    expect(
      WriterResultSchema.safeParse({
        ...RESULT,
        imageMarkers: [{ ...RESULT.imageMarkers[0], role: 'inline' }],
      }).success,
    ).toBe(false);
    expect(
      WriterResultSchema.safeParse({
        ...RESULT,
        linkMarkers: [{ markerId: 'image-1', anchorTextHint: 'duplicate id with image marker' }],
      }).success,
    ).toBe(false);
    expect(
      WriterResultSchema.safeParse({
        ...RESULT,
        markdown: `${RESULT.markdown} link-1`,
      }).success,
    ).toBe(false);
    expect(
      WriterResultSchema.safeParse({
        ...RESULT,
        linkMarkers: [],
      }).success,
    ).toBe(false);
    expect(
      WriterResultSchema.safeParse({
        ...RESULT,
        imageMarkers: [],
      }).success,
    ).toBe(false);
  });

  it('projects the rich result into the frozen, minimal PipelineState Draft', () => {
    const draft = toDraft(RESULT);

    expect(draft).toEqual({
      markdown: RESULT.markdown,
      wordCount: RESULT.wordCount,
      linkMarkers: RESULT.linkMarkers,
      imageMarkers: RESULT.imageMarkers,
    });
  });
});

describe('Draft Writer execution', () => {
  it('executes only through ModuleRunner, resolves the registered prompt, and records cost', async () => {
    const promptCalls: Readonly<Record<string, string>>[] = [];
    const services = createServices(JSON.stringify(RESULT), true, promptCalls);
    const module = createDraftWriterModule();
    const registry = createModuleRegistry<DraftWriterModuleServices>().register(module);
    const runner = new ModuleRunner({ registry, clock: new FakeClock() });
    const state = createState();

    const result = await runner.run(module, buildWriterRequest(state), state, services);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output).toEqual(RESULT);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.linkMarkers)).toBe(true);
    expect(Object.isFrozen(result.output.imageMarkers[0])).toBe(true);
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({
      angle: PLANNING.angle,
      targetWordCount: String(PLANNING.targetWordCount),
      focusKeyword: SEO.focusKeyword,
    });
    const provider = services.llmProvider as FakeLLMProvider;
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      moduleKey: 'writer',
      systemPrompt: 'Draft Writer system prompt',
      userPrompt: 'Draft Writer user prompt',
      responseFormat: 'json',
      maxOutputTokens: 6_000,
    });
    expect(provider.calls[0]?.jsonSchema).toBeDefined();
    expect(result.state.metrics.costEvents).toEqual([
      {
        runId: state.metadata.runId,
        moduleKey: 'writer',
        attemptNumber: 1,
        timestamp: '2026-07-24T15:00:00.000Z',
        provider: 'openai',
        modelId: 'gpt-5.6-terra',
        promptVersion: 'jkl3456',
        inputTokens: 320,
        outputTokens: 1_800,
        cachedInputTokens: 10,
        reasoningTokens: 0,
        estimatedCostUsd: 0.084,
        pricingVerifiedAt: '2026-07-01',
        latencyMs: 20,
        outcome: 'success',
        isImageGeneration: false,
      },
    ]);
    expect(result.state.metrics.totalCostUsd).toBeCloseTo(0.084);
    expect(result.state.timings).toHaveLength(1);
    expect(state.metrics.costEvents).toEqual([]);
    expect(state.timings).toEqual([]);
  });

  it('falls back to local JSON parsing when the provider lacks JSON-schema support', async () => {
    const services = createServices(JSON.stringify(RESULT), false);
    const module = createDraftWriterModule();
    const registry = createModuleRegistry<DraftWriterModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildWriterRequest(createState()),
      createState(),
      services,
    );

    expect(result.ok).toBe(true);
    expect((services.llmProvider as FakeLLMProvider).calls[0]?.jsonSchema).toBeUndefined();
  });

  it('returns a typed validation failure and validation cost event for malformed provider output', async () => {
    const services = createServices('{"not":"the expected schema"}');
    const module = createDraftWriterModule();
    const state = createState();
    const registry = createModuleRegistry<DraftWriterModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildWriterRequest(state),
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
    const providerError = new ProviderError('writer', 'openai', 503, true);
    const services: DraftWriterModuleServices = {
      promptRegistry: createPromptRegistry(),
      llmProvider: new FakeLLMProvider({ throws: providerError }),
    };
    const module = createDraftWriterModule();
    const state = createState();
    const registry = createModuleRegistry<DraftWriterModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildWriterRequest(state),
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

describe('Draft Writer registry and orchestrator compatibility', () => {
  it('declares frozen dependencies and capabilities and registers independently', () => {
    const registry = createModuleRegistry<DraftWriterModuleServices>();
    registerDraftWriterModule(registry);

    const module = registry.require('writer');
    expect(module.metadata.dependencies).toEqual(['research', 'planner', 'seo-planner']);
    expect(module.metadata.capabilities).toEqual({
      requires: [
        'llm.complete',
        'prompt-registry.get',
        'research.structured-output',
        'planner.content-plan',
        'seo.strategy',
      ],
      provides: ['writer.draft', 'writer.state-projection'],
    });
    expect(Object.isFrozen(module.metadata)).toBe(true);
    expect(() => registerDraftWriterModule(registry)).toThrow(/already registered/);
  });

  it('executes through PipelineOrchestrator and projects only the frozen draft state', async () => {
    const services = createServices();
    const draftWriter = createDraftWriterModule();
    const research = researchModule();
    const planner = plannerModule();
    const seo = seoModule();
    const registry = createModuleRegistry<DraftWriterModuleServices>()
      .register(draftWriter)
      .register(research)
      .register(planner)
      .register(seo);
    const store = new MemoryStateStore();
    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry, clock: new FakeClock() }),
      stateStore: store,
      services,
      bindings: [
        researchBinding(),
        plannerBinding(),
        seoBinding(),
        createDraftWriterModuleBinding(),
      ],
    });
    const initialState = createState();

    const result = await orchestrator.execute(initialState);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(orchestrator.executionOrder()).toEqual(['research', 'planner', 'seo-planner', 'writer']);
    expect(result.state.draft).toEqual({
      current: toDraft(RESULT),
      history: [],
    });
    expect(result.state.metadata.runId).toBe(initialState.metadata.runId);
    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(initialState.draft).toBeUndefined();
    expect(store.states).toHaveLength(6);
  });

  it('appends history when the draft is replaced a second time through the binding', () => {
    const binding = createDraftWriterModuleBinding();
    const state = createState();
    const context = {
      runId: state.metadata.runId,
      module: { key: 'writer' } as ModuleMetadata,
      state,
      services: createServices(),
      registry: createModuleRegistry<DraftWriterModuleServices>(),
      dependencyGraph: {
        nodes: [],
        dependenciesOf: () => [],
        dependentsOf: () => [],
        executionOrder: () => [],
      },
      executionOrder: [],
      resumePoint: { completed: [], pending: [], next: undefined },
    };

    const afterFirst = binding.applyOutput(state, RESULT, context);
    const secondResult: WriterResult = { ...RESULT, wordCount: RESULT.wordCount + 5 };
    const afterSecond = binding.applyOutput(afterFirst, secondResult, context);

    expect(afterSecond.draft?.current).toEqual(toDraft(secondResult));
    expect(afterSecond.draft?.history).toHaveLength(1);
    expect(afterSecond.draft?.history[0]?.producedBy).toBe('writer');
    expect(afterSecond.draft?.history[0]?.draft).toEqual(toDraft(RESULT));
  });
});

describe('Draft Writer input normalization', () => {
  it('rejects a request that fails schema validation', () => {
    expect(() =>
      normalizeWriterRequest({
        research: RESEARCH,
        planning: PLANNING,
        seo: {
          ...SEO,
          internalLinkTargets: [
            { candidateSlug: 'slug', candidateTitle: 'title', relevance: 'unsupported' as never },
          ],
        },
      }),
    ).toThrow(ValidationError);
  });
});
