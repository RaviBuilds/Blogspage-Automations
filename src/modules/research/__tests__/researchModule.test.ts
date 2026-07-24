/** Tests for the provider-agnostic Research module and its pipeline adapters. */

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
import { BriefSchema, createInitialState, type PipelineState } from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptRegistry } from '@/prompts/registry.js';

import {
  buildResearchRequest,
  createResearchModule,
  createResearchModuleBinding,
  normalizeResearchRequest,
  registerResearchModule,
  ResearchRequestSchema,
  ResearchResultSchema,
  type ResearchModuleServices,
  type ResearchResult,
} from '../researchModule.js';

const RESULT: ResearchResult = {
  topic: 'Immutable pipeline state',
  targetAudience: 'Platform engineers',
  searchIntent: 'Learn how immutable state makes content pipelines reliable.',
  primaryKeywords: ['immutable pipeline state'],
  secondaryKeywords: ['workflow checkpointing'],
  competitorObservations: [
    {
      competitor: 'Generic workflow guides',
      observation: 'They omit immutable checkpoint recovery.',
    },
  ],
  questionsUsersAsk: ['How does immutable state support resumable pipelines?'],
  keyInsights: [
    'Immutable state snapshots make retry boundaries auditable.',
    'Append-only timing records retain a deterministic execution history.',
    'A module-specific output contract prevents downstream provider coupling.',
  ],
  references: [
    {
      title: 'Pipeline state patterns',
      source: 'Internal architecture documentation',
    },
  ],
  confidenceScore: 0.92,
  suggestedAngle: 'Frame immutable state as the practical foundation for reliable automation.',
  candidateStatistics: [
    {
      claim: 'Checkpointed jobs can resume without rerunning completed work.',
      informalSource: 'workflow orchestration engineering guidance',
    },
  ],
};

class FakeClock implements ModuleRunnerClock {
  private wallIndex = 0;
  private monotonicIndex = 0;

  public constructor(
    private readonly wallTimes: readonly string[] = [
      '2026-07-24T14:00:00.000Z',
      '2026-07-24T14:00:00.020Z',
    ],
    private readonly monotonicTimes: readonly number[] = [100, 120, 200, 220],
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

function createPromptRegistry(): PromptRegistry {
  return {
    get: () =>
      Promise.resolve({
        system: 'Research system prompt',
        user: 'Research user prompt',
        promptVersion: 'abc1234',
      }),
  };
}

function createServices(
  response: string = JSON.stringify(RESULT),
  jsonSchema = true,
): ResearchModuleServices {
  return {
    promptRegistry: createPromptRegistry(),
    llmProvider: new FakeLLMProvider({
      text: response,
      capabilities: { vision: false, jsonSchema, caching: false, reasoning: false },
      providerName: 'openai',
      modelId: 'gpt-5.6-terra',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 120, outputTokens: 180, cachedInputTokens: 4, reasoningTokens: 8 },
      costUsd: 0.014,
    }),
  };
}

function createState(): PipelineState {
  const state = createInitialState({ sheetRowId: 'row-1' });
  return {
    ...state,
    brief: {
      topic: RESULT.topic,
      targetAudience: RESULT.targetAudience,
      keywordHints: ['immutable pipeline state', 'immutable pipeline state', ' recovery '],
      constraints: ['Use precise language', 'Use precise language'],
      sheetRowId: 'row-1',
    },
  };
}

function sheetReaderModule(): PipelineModule<
  undefined,
  PipelineState['brief'],
  ResearchModuleServices
> {
  const metadata: ModuleMetadata = {
    key: 'sheet-reader',
    displayName: 'Sheet Reader Test Double',
    description: 'Supplies a brief for Research module orchestration testing.',
    dependencies: [],
    capabilities: { requires: [], provides: ['brief'] },
  };

  return defineModule({
    metadata,
    execute: (_input, context) => context.state.brief,
  });
}

function sheetReaderBinding(): OrchestratorModuleBinding<ResearchModuleServices> {
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

describe('Research Module contracts', () => {
  it('normalizes a Brief into a frozen, deterministic request', () => {
    const request = buildResearchRequest(createState());

    expect(request).toEqual({
      topic: RESULT.topic,
      targetAudience: RESULT.targetAudience,
      keywordHints: ['immutable pipeline state', 'recovery'],
      constraints: ['Use precise language'],
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.keywordHints)).toBe(true);
    expect(() => buildResearchRequest(createInitialState())).toThrow(ValidationError);
    expect(() =>
      normalizeResearchRequest({
        topic: ' ',
        targetAudience: 'Audience',
        keywordHints: [],
        constraints: [],
      }),
    ).toThrow(ValidationError);
  });

  it('validates the complete strict public result contract', () => {
    expect(ResearchRequestSchema.parse(buildResearchRequest(createState()))).toEqual(
      buildResearchRequest(createState()),
    );
    expect(ResearchResultSchema.parse(RESULT)).toEqual(RESULT);
    expect(ResearchResultSchema.safeParse({ ...RESULT, unownedProperty: true }).success).toBe(
      false,
    );
    expect(
      ResearchResultSchema.safeParse({ ...RESULT, keyInsights: RESULT.keyInsights.slice(0, 2) })
        .success,
    ).toBe(false);
  });
});

describe('Research Module execution', () => {
  it('executes only through ModuleRunner, uses the injected provider abstraction, and records cost', async () => {
    const services = createServices();
    const module = createResearchModule();
    const registry = createModuleRegistry<ResearchModuleServices>().register(module);
    const runner = new ModuleRunner({ registry, clock: new FakeClock() });
    const state = createState();

    const result = await runner.run(module, buildResearchRequest(state), state, services);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output).toEqual(RESULT);
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(Object.isFrozen(result.output.references)).toBe(true);
    expect(services.llmProvider).toBeInstanceOf(FakeLLMProvider);
    const provider = services.llmProvider as FakeLLMProvider;
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      moduleKey: 'research',
      systemPrompt: 'Research system prompt',
      userPrompt: 'Research user prompt',
      responseFormat: 'json',
      maxOutputTokens: 1800,
    });
    expect(provider.calls[0]?.jsonSchema).toBeDefined();
    expect(result.state.metrics.costEvents).toEqual([
      {
        runId: state.metadata.runId,
        moduleKey: 'research',
        attemptNumber: 1,
        timestamp: '2026-07-24T14:00:00.000Z',
        provider: 'openai',
        modelId: 'gpt-5.6-terra',
        promptVersion: 'abc1234',
        inputTokens: 120,
        outputTokens: 180,
        cachedInputTokens: 4,
        reasoningTokens: 8,
        estimatedCostUsd: 0.014,
        pricingVerifiedAt: '2026-07-01',
        latencyMs: 20,
        outcome: 'success',
        isImageGeneration: false,
      },
    ]);
    expect(result.state.metrics.totalCostUsd).toBeCloseTo(0.014);
    expect(result.state.timings).toHaveLength(1);
    expect(state.metrics.costEvents).toEqual([]);
    expect(state.timings).toEqual([]);
  });

  it('does not require JSON-schema support from the configured provider', async () => {
    const services = createServices(JSON.stringify(RESULT), false);
    const module = createResearchModule();
    const registry = createModuleRegistry<ResearchModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildResearchRequest(createState()),
      createState(),
      services,
    );

    expect(result.ok).toBe(true);
    expect((services.llmProvider as FakeLLMProvider).calls[0]?.jsonSchema).toBeUndefined();
  });

  it('returns a typed validation failure and a validation cost event for malformed provider JSON', async () => {
    const services = createServices('{"not":"the expected schema"}');
    const module = createResearchModule();
    const state = createState();
    const registry = createModuleRegistry<ResearchModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildResearchRequest(state),
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
    const providerError = new ProviderError('research', 'openai', 503, true);
    const services: ResearchModuleServices = {
      promptRegistry: createPromptRegistry(),
      llmProvider: new FakeLLMProvider({ throws: providerError }),
    };
    const module = createResearchModule();
    const state = createState();
    const registry = createModuleRegistry<ResearchModuleServices>().register(module);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildResearchRequest(state),
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

describe('Research Module registry and orchestrator compatibility', () => {
  it('declares its frozen dependency/capabilities and registers independently', () => {
    const registry = createModuleRegistry<ResearchModuleServices>();
    registerResearchModule(registry);

    const module = registry.require('research');
    expect(module.metadata.dependencies).toEqual(['sheet-reader']);
    expect(module.metadata.capabilities).toEqual({
      requires: ['llm.complete', 'prompt-registry.get'],
      provides: ['research.structured-output', 'research.state-projection'],
    });
    expect(Object.isFrozen(module.metadata)).toBe(true);
    expect(() => registerResearchModule(registry)).toThrow(/already registered/);
  });

  it('executes through PipelineOrchestrator and projects output only into research state', async () => {
    const services = createServices();
    const research = createResearchModule();
    const sheetReader = sheetReaderModule();
    const registry = createModuleRegistry<ResearchModuleServices>()
      .register(research)
      .register(sheetReader);
    const store = new MemoryStateStore();
    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry, clock: new FakeClock() }),
      stateStore: store,
      services,
      bindings: [sheetReaderBinding(), createResearchModuleBinding()],
    });
    const initialState = createState();

    const result = await orchestrator.execute(initialState);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(orchestrator.executionOrder()).toEqual(['sheet-reader', 'research']);
    expect(result.state.research).toEqual({
      keyFacts: RESULT.keyInsights,
      suggestedAngle: RESULT.suggestedAngle,
      competitorGapNotes: ['Generic workflow guides: They omit immutable checkpoint recovery.'],
      candidateStatistics: RESULT.candidateStatistics,
    });
    expect(result.state.metadata.runId).toBe(initialState.metadata.runId);
    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(initialState.research).toBeUndefined();
    expect(store.states).toHaveLength(4);
  });
});
