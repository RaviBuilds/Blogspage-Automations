/** Tests for dependency-driven PipelineOrchestrator coordination. */

import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import {
  createModuleRegistry,
  defineModule,
  ModuleRunner,
  type ModuleMetadata,
  type PipelineModule,
} from '../moduleRunner.js';
import {
  PipelineOrchestrator,
  type OrchestratorModuleBinding,
  type PipelineStateCheckpointStore,
} from '../orchestrator.js';
import {
  createInitialState,
  setReviewLoopIteration,
  type PipelineState,
  type ResearchSection,
} from '../state.js';
import type { ModuleKey } from '../types.js';

interface Services {
  readonly executionLog: string[];
}

interface SavedSnapshot {
  readonly state: PipelineState;
  readonly suffix: string | undefined;
}

class MemoryStateStore implements PipelineStateCheckpointStore {
  public readonly snapshots: SavedSnapshot[] = [];

  public save(state: PipelineState, suffix?: string): Promise<void> {
    this.snapshots.push({ state, suffix });
    return Promise.resolve();
  }
}

function metadata(key: ModuleKey, dependencies: readonly ModuleKey[] = []): ModuleMetadata {
  return {
    key,
    displayName: `${key} module`,
    description: `Coordinates ${key} in an orchestrator test.`,
    dependencies,
    capabilities: { requires: [], provides: [`${key}-output`] },
  };
}

function createModule<TOutput>(
  key: ModuleKey,
  execute: PipelineModule<undefined, TOutput, Services>['execute'],
  dependencies: readonly ModuleKey[] = [],
): PipelineModule<undefined, TOutput, Services> {
  return defineModule({ metadata: metadata(key, dependencies), execute });
}

function createOrchestrator(
  registry: ReturnType<typeof createModuleRegistry<Services>>,
  store: MemoryStateStore,
  bindings: readonly OrchestratorModuleBinding<Services>[],
  services: Services,
): PipelineOrchestrator<Services> {
  return new PipelineOrchestrator({
    registry,
    runner: new ModuleRunner({ registry }),
    stateStore: store,
    services,
    bindings,
  });
}

function binding(
  key: ModuleKey,
  applyOutput: OrchestratorModuleBinding<Services>['applyOutput'],
): OrchestratorModuleBinding<Services> {
  return { key, createInput: () => undefined, applyOutput };
}

describe('PipelineOrchestrator', () => {
  it('uses registry dependency order, invokes modules through ModuleRunner, and checkpoints immutable transitions', async () => {
    const services: Services = { executionLog: [] };
    const sheetReader = createModule('sheet-reader', (_input, context) => {
      context.services.executionLog.push('sheet-reader');
      return { topic: 'Orchestration', sheetRowId: 'row-1' };
    });
    const research = createModule(
      'research',
      (_input, context) => {
        context.services.executionLog.push('research');
        expect(context.state.brief?.topic).toBe('Orchestration');
        return {
          keyFacts: ['Registry order is deterministic.'],
          suggestedAngle: 'Explain dependency-driven execution.',
          candidateStatistics: [],
        };
      },
      ['sheet-reader'],
    );
    const registry = createModuleRegistry<Services>().register(research).register(sheetReader);
    const store = new MemoryStateStore();
    const orchestrator = createOrchestrator(
      registry,
      store,
      [
        binding('sheet-reader', (state, output) => {
          if (!isBriefOutput(output)) {
            throw new Error('Expected a Brief output.');
          }
          return {
            ...state,
            metadata: { ...state.metadata, sheetRowId: output.sheetRowId },
            brief: output,
          };
        }),
        binding('research', (state, output) => {
          if (!isResearchOutput(output)) {
            throw new Error('Expected a ResearchSection output.');
          }
          return { ...state, research: output };
        }),
      ],
      services,
    );

    const initialState = createInitialState();
    const result = await orchestrator.execute(initialState);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.metadata.status).toBe('published');
      expect(result.state.brief?.topic).toBe('Orchestration');
      expect(result.state.research?.suggestedAngle).toBe('Explain dependency-driven execution.');
      expect(result.state.timings).toHaveLength(2);
      expect(result.executions.map((execution) => execution.module)).toEqual([
        'sheet-reader',
        'research',
      ]);
      expect(result.events.map((event) => event.type)).toEqual([
        'pipeline.started',
        'module.started',
        'module.succeeded',
        'module.started',
        'module.succeeded',
        'pipeline.completed',
      ]);
    }
    expect(services.executionLog).toEqual(['sheet-reader', 'research']);
    expect(orchestrator.executionOrder()).toEqual(['sheet-reader', 'research']);
    expect(store.snapshots.map((snapshot) => snapshot.suffix)).toEqual([
      undefined,
      undefined,
      undefined,
      'completed',
    ]);
    expect(store.snapshots[0]?.state).not.toBe(initialState);
    expect(initialState.metadata.status).toBe('running');
    expect(initialState.timings).toEqual([]);
  });

  it('halts downstream scheduling, persists failure state, and returns the ModuleRunner failure unchanged', async () => {
    const services: Services = { executionLog: [] };
    const failure = new ProviderError('research', 'test-provider', 503, true);
    const sheetReader = createModule('sheet-reader', (_input, context) => {
      context.services.executionLog.push('sheet-reader');
      return { topic: 'Failure routing', sheetRowId: 'row-2' };
    });
    const research = createModule(
      'research',
      (_input, context) => {
        context.services.executionLog.push('research');
        throw failure;
      },
      ['sheet-reader'],
    );
    const writer = createModule(
      'writer',
      (_input, context) => {
        context.services.executionLog.push('writer');
        return 'must not execute';
      },
      ['research'],
    );
    const registry = createModuleRegistry<Services>()
      .register(writer)
      .register(research)
      .register(sheetReader);
    const store = new MemoryStateStore();
    const orchestrator = createOrchestrator(
      registry,
      store,
      [
        binding('sheet-reader', (state, output) => {
          if (!isBriefOutput(output)) {
            throw new Error('Expected a Brief output.');
          }
          return {
            ...state,
            metadata: { ...state.metadata, sheetRowId: output.sheetRowId },
            brief: output,
          };
        }),
        binding('research', (state) => state),
        binding('writer', (state) => state),
      ],
      services,
    );

    const result = await orchestrator.execute(createInitialState());

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'module-failure') {
      expect(result.module).toBe('research');
      expect(result.error).toBe(failure);
      expect(result.state.metadata.status).toBe('failed');
      expect(result.state.timings).toHaveLength(2);
      expect(result.state.errors).toHaveLength(1);
      expect(result.events.map((event) => event.type)).toEqual([
        'pipeline.started',
        'module.started',
        'module.succeeded',
        'module.started',
        'module.failed',
        'pipeline.completed',
      ]);
    }
    expect(services.executionLog).toEqual(['sheet-reader', 'research']);
    expect(store.snapshots.map((snapshot) => snapshot.suffix)).toEqual([
      undefined,
      undefined,
      'failed',
    ]);
  });

  it('prepares a resume point from successful audit records and skips completed modules', async () => {
    const services: Services = { executionLog: [] };
    const sheetReader = createModule('sheet-reader', (_input, context) => {
      context.services.executionLog.push('sheet-reader');
      return { topic: 'Skipped work', sheetRowId: 'row-3' };
    });
    const research = createModule(
      'research',
      (_input, context) => {
        context.services.executionLog.push('research');
        return {
          keyFacts: ['State snapshots make resumption safe.'],
          suggestedAngle: 'Continue after the latest completed module.',
          candidateStatistics: [],
        };
      },
      ['sheet-reader'],
    );
    const registry = createModuleRegistry<Services>().register(sheetReader).register(research);
    const store = new MemoryStateStore();
    const orchestrator = createOrchestrator(
      registry,
      store,
      [
        binding('sheet-reader', (state) => state),
        binding('research', (state, output) => {
          if (!isResearchOutput(output)) {
            throw new Error('Expected a ResearchSection output.');
          }
          return { ...state, research: output };
        }),
      ],
      services,
    );
    const initialState = createInitialState({ sheetRowId: 'row-3' });
    const resumedState: PipelineState = {
      ...initialState,
      brief: { topic: 'Skipped work', sheetRowId: 'row-3' },
      timings: [
        {
          runId: initialState.metadata.runId,
          module: 'sheet-reader',
          attemptNumber: 1,
          startedAt: '2026-07-24T12:00:00.000Z',
          durationMs: 10,
        },
      ],
    };

    expect(orchestrator.prepareResumePoint(resumedState)).toEqual({
      completed: ['sheet-reader'],
      pending: ['research'],
      next: 'research',
    });

    const result = await orchestrator.execute(resumedState);

    expect(result.ok).toBe(true);
    expect(services.executionLog).toEqual(['research']);
    if (result.ok) {
      expect(result.resumePoint.completed).toEqual(['sheet-reader']);
      expect(result.state.timings).toHaveLength(2);
    }
  });
});

function isBriefOutput(
  output: unknown,
): output is { readonly topic: string; readonly sheetRowId: string } {
  return (
    typeof output === 'object' &&
    output !== null &&
    'topic' in output &&
    typeof output.topic === 'string' &&
    'sheetRowId' in output &&
    typeof output.sheetRowId === 'string'
  );
}

function isResearchOutput(output: unknown): output is ResearchSection {
  return (
    typeof output === 'object' &&
    output !== null &&
    'keyFacts' in output &&
    Array.isArray(output.keyFacts) &&
    output.keyFacts.every((fact): fact is string => typeof fact === 'string') &&
    'suggestedAngle' in output &&
    typeof output.suggestedAngle === 'string' &&
    'candidateStatistics' in output &&
    Array.isArray(output.candidateStatistics) &&
    output.candidateStatistics.every(isCandidateStatistic) &&
    (!('competitorGapNotes' in output) ||
      output.competitorGapNotes === undefined ||
      (Array.isArray(output.competitorGapNotes) &&
        output.competitorGapNotes.every((note): note is string => typeof note === 'string')))
  );
}

describe('PipelineOrchestrator — human-in-the-loop pause', () => {
  it('stops cleanly at a pause status and does not run downstream modules', async () => {
    const services: Services = { executionLog: [] };
    const sheetReader = createModule('sheet-reader', (_input, context) => {
      context.services.executionLog.push('sheet-reader');
      return { topic: 'Pause flow', sheetRowId: 'row-4' };
    });
    const research = createModule(
      'research',
      (_input, context) => {
        context.services.executionLog.push('research');
        return {
          keyFacts: [],
          suggestedAngle: 'Should never run before the pause.',
          candidateStatistics: [],
        };
      },
      ['sheet-reader'],
    );
    const registry = createModuleRegistry<Services>().register(research).register(sheetReader);
    const store = new MemoryStateStore();

    let pauseRequested = false;
    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry }),
      stateStore: store,
      services,
      bindings: [
        binding('sheet-reader', (state, _output) => ({
          ...state,
          brief: { topic: 'Pause flow', sheetRowId: 'row-4' },
        })),
        binding('research', (state) => state),
      ],
      pauseAfter: () => {
        if (!pauseRequested) {
          pauseRequested = true;
          return 'awaiting_assets';
        }
        return undefined;
      },
    });

    const result = await orchestrator.execute(createInitialState({ sheetRowId: 'row-4' }));

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') {
      return;
    }
    expect(result.status).toBe('awaiting_assets');
    expect(result.state.metadata.status).toBe('awaiting_assets');
    expect(result.resumePoint.completed).toEqual(['sheet-reader']);
    expect(result.resumePoint.pending).toContain('research');
    expect(services.executionLog).toEqual(['sheet-reader']);
    expect(result.events.some((event) => event.type === 'pipeline.paused')).toBe(true);
  });
});
function isCandidateStatistic(
  value: unknown,
): value is { readonly claim: string; readonly informalSource?: string | undefined } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'claim' in value &&
    typeof value.claim === 'string' &&
    (!('informalSource' in value) ||
      value.informalSource === undefined ||
      typeof value.informalSource === 'string')
  );
}
describe('PipelineOrchestrator — bounded review loop', () => {
  it('re-runs the loop cycle once on a rerun decision', async () => {
    const services: Services = { executionLog: [] };
    const sheetReader = createModule('sheet-reader', (_input, context) => {
      context.services.executionLog.push('sheet-reader');
      return { topic: 'Loop test', sheetRowId: 'row-5' };
    });
    const research = createModule(
      'research',
      (_input, context) => {
        context.services.executionLog.push('research');
        return { keyFacts: [], suggestedAngle: 'a', candidateStatistics: [] };
      },
      ['sheet-reader'],
    );
    const qa = createModule(
      'qa',
      (_input, context) => {
        context.services.executionLog.push('qa');
        return { decision: 'needsRevision', remainingIssues: [] };
      },
      ['research'],
    );
    const registry = createModuleRegistry<Services>()
      .register(research)
      .register(sheetReader)
      .register(qa);
    const store = new MemoryStateStore();

    let reruns = 0;
    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry }),
      stateStore: store,
      services,
      bindings: [
        binding('sheet-reader', (state) => state),
        binding('research', (state) => state),
        binding('qa', (state) => ({
          ...state,
          qa: { decision: 'needsRevision', remainingIssues: [] },
        })),
      ],
      loopAfter: (state, moduleKey) => {
        if (moduleKey !== 'qa' || state.qa === undefined) {
          return undefined;
        }
        if (reruns < 1) {
          reruns += 1;
          return {
            action: 'rerun',
            state: setReviewLoopIteration(state, 1),
            iteration: 1,
            cycleKeys: Object.freeze(['qa']),
          };
        }
        return undefined;
      },
    });

    const result = await orchestrator.execute(createInitialState({ sheetRowId: 'row-5' }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(services.executionLog.filter((entry) => entry === 'qa')).toHaveLength(2);
    expect(result.state.review?.loop?.iteration ?? 0).toBe(1);
  });

  it('stops at needs_review on a failClosed decision', async () => {
    const services: Services = { executionLog: [] };
    const sheetReader = createModule('sheet-reader', (_input, context) => {
      context.services.executionLog.push('sheet-reader');
      return { topic: 'Fail closed', sheetRowId: 'row-6' };
    });
    const qa = createModule(
      'qa',
      (_input, context) => {
        context.services.executionLog.push('qa');
        return { decision: 'failClosed', remainingIssues: [] };
      },
      ['sheet-reader'],
    );
    const registry = createModuleRegistry<Services>().register(sheetReader).register(qa);
    const store = new MemoryStateStore();

    const orchestrator = new PipelineOrchestrator({
      registry,
      runner: new ModuleRunner({ registry }),
      stateStore: store,
      services,
      bindings: [
        binding('sheet-reader', (state) => state),
        binding('qa', (state) => ({
          ...state,
          qa: { decision: 'failClosed', remainingIssues: [] },
        })),
      ],
      loopAfter: (_state, moduleKey) => (moduleKey === 'qa' ? { action: 'failClosed' } : undefined),
    });

    const result = await orchestrator.execute(createInitialState({ sheetRowId: 'row-6' }));

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('paused');
    if (result.kind !== 'paused') {
      return;
    }
    expect(result.status).toBe('needs_review');
  });
});
