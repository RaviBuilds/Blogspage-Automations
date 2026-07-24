/** Tests for registry-driven module execution and immutable runner audit records. */

import { describe, expect, it } from 'vitest';
import { ProviderError, ValidationError } from '../errors.js';
import {
  createModuleRegistry,
  defineModule,
  ModuleRunner,
  type ModuleMetadata,
  type PipelineModule,
} from '../moduleRunner.js';
import { createInitialState } from '../state.js';
import type { ModuleKey } from '../types.js';

interface Services {
  readonly prefix: string;
}

class FakeClock {
  private readonly wallTimes: readonly Date[];
  private readonly monotonicTimes: readonly number[];
  private wallIndex = 0;
  private monotonicIndex = 0;

  public constructor(
    wallTimes: readonly string[] = ['2026-07-24T08:00:00.000Z', '2026-07-24T08:00:00.015Z'],
    monotonicTimes: readonly number[] = [100, 115],
  ) {
    this.wallTimes = wallTimes.map((time) => new Date(time));
    this.monotonicTimes = monotonicTimes;
  }

  public now(): Date {
    const time = this.wallTimes[this.wallIndex];
    this.wallIndex += 1;
    if (time === undefined) {
      throw new Error('FakeClock has no remaining wall-clock values.');
    }
    return time;
  }

  public monotonicNow(): number {
    const time = this.monotonicTimes[this.monotonicIndex];
    this.monotonicIndex += 1;
    if (time === undefined) {
      throw new Error('FakeClock has no remaining monotonic values.');
    }
    return time;
  }
}

function metadata(key: ModuleKey, dependencies: readonly ModuleKey[] = []): ModuleMetadata {
  return {
    key,
    displayName: `${key} module`,
    description: `Runs the ${key} test module.`,
    dependencies,
    capabilities: {
      requires: [],
      provides: [`${key}-output`],
    },
  };
}

function createModule<TInput, TOutput>(
  key: ModuleKey,
  execute: PipelineModule<TInput, TOutput, Services>['execute'],
  dependencies: readonly ModuleKey[] = [],
): PipelineModule<TInput, TOutput, Services> {
  return defineModule({
    metadata: metadata(key, dependencies),
    execute,
  });
}

describe('ModuleRegistry', () => {
  it('registers independently exported modules and exposes immutable discovery metadata', () => {
    const module = createModule('research', () => ({ facts: 1 }));
    const registry = createModuleRegistry<Services>().register(module);

    expect(registry.has('research')).toBe(true);
    expect(registry.get('research')).toBeDefined();
    expect(registry.list()).toEqual([module.metadata]);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(module.metadata)).toBe(true);
    expect(Object.isFrozen(module.metadata.capabilities)).toBe(true);
  });

  it('rejects duplicate registration and unknown discovery keys', () => {
    const module = createModule('research', () => ({ facts: 1 }));
    const registry = createModuleRegistry<Services>().register(module);

    expect(() => registry.register(module)).toThrow(/already registered/);
    expect(() => registry.require('writer')).toThrow(/No module is registered/);
  });

  it('validates declared dependencies and derives deterministic graph relations', () => {
    const sheetReader = createModule('sheet-reader', () => 'brief');
    const research = createModule('research', () => 'research', ['sheet-reader']);
    const planner = createModule('planner', () => 'plan', ['research']);
    const registry = createModuleRegistry<Services>()
      .register(planner)
      .register(research)
      .register(sheetReader);
    const graph = registry.dependencyGraph();

    expect(graph.nodes).toEqual(['planner', 'research', 'sheet-reader']);
    expect(graph.dependenciesOf('planner')).toEqual(['research']);
    expect(graph.dependentsOf('research')).toEqual(['planner']);
    expect(graph.executionOrder()).toEqual(['sheet-reader', 'research', 'planner']);
    expect(Object.isFrozen(graph.executionOrder())).toBe(true);
  });

  it('rejects dependency cycles and dependencies missing from the registry', () => {
    const research = createModule('research', () => 'research', ['planner']);
    const planner = createModule('planner', () => 'plan', ['research']);
    const cyclicRegistry = createModuleRegistry<Services>().register(research).register(planner);
    const orphanedRegistry = createModuleRegistry<Services>().register(
      createModule('research', () => 'research', ['sheet-reader']),
    );

    expect(() => cyclicRegistry.dependencyGraph()).toThrow(/cycle detected/);
    expect(() => orphanedRegistry.dependencyGraph()).toThrow(/unregistered module/);
  });

  it('rejects incomplete or self-referential immutable metadata', () => {
    expect(() =>
      defineModule({
        metadata: {
          ...metadata('research'),
          displayName: ' ',
        },
        execute: () => 'result',
      }),
    ).toThrow(/displayName/);

    expect(() =>
      defineModule({
        metadata: metadata('research', ['research']),
        execute: () => 'result',
      }),
    ).toThrow(/cannot depend on itself/);
  });
});

describe('ModuleRunner', () => {
  it('injects immutable state, services, and context into a registered module', async () => {
    const state = createInitialState();
    const module = createModule<{ readonly value: string }, string>(
      'research',
      (input, context) => {
        expect(context.runId).toBe(state.metadata.runId);
        expect(context.state).toBe(state);
        expect(context.module.key).toBe('research');
        expect(context.services.prefix).toBe('processed:');
        expect(context.startedAt).toBe('2026-07-24T08:00:00.000Z');
        expect(Object.isFrozen(context)).toBe(true);
        return `${context.services.prefix}${input.value}`;
      },
    );
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(module),
      clock: new FakeClock(),
    });

    const result = await runner.run(module, { value: 'topic' }, state, { prefix: 'processed:' });

    expect(result).toEqual({
      ok: true,
      output: 'processed:topic',
      state: {
        ...state,
        timings: [
          {
            runId: state.metadata.runId,
            module: 'research',
            attemptNumber: 1,
            startedAt: '2026-07-24T08:00:00.000Z',
            durationMs: 15,
          },
        ],
      },
      timing: {
        runId: state.metadata.runId,
        module: 'research',
        attemptNumber: 1,
        startedAt: '2026-07-24T08:00:00.000Z',
        durationMs: 15,
      },
    });
    expect(state.timings).toEqual([]);
  });

  it('supports key-based execution for independently discovered modules', async () => {
    const module = createModule<{ readonly count: number }, number>(
      'research',
      (input) => input.count * 2,
    );
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(module),
      clock: new FakeClock(),
    });

    const result = await runner.runByKey('research', { count: 4 }, createInitialState(), {
      prefix: '',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe(8);
    }
  });

  it('runs lifecycle hooks in a deterministic order around successful execution', async () => {
    const calls: string[] = [];
    const module = defineModule({
      metadata: metadata('research'),
      lifecycle: {
        onStart: () => {
          calls.push('module:start');
        },
        onSuccess: () => {
          calls.push('module:success');
        },
      },
      execute: () => {
        calls.push('execute');
        return 'done';
      },
    });
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(module),
      clock: new FakeClock(),
      lifecycle: {
        onStart: () => {
          calls.push('runner:start');
        },
        onSuccess: () => {
          calls.push('runner:success');
        },
      },
    });

    const result = await runner.run(module, undefined, createInitialState(), { prefix: '' });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      'runner:start',
      'module:start',
      'execute',
      'module:success',
      'runner:success',
    ]);
  });

  it('preserves typed failures and appends immutable timing and error records', async () => {
    const state = createInitialState();
    const failure = new ProviderError('research', 'anthropic', 429, true);
    const module = createModule('research', () => {
      throw failure;
    });
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(module),
      clock: new FakeClock(['2026-07-24T08:00:00.000Z', '2026-07-24T08:00:00.020Z'], [50, 70]),
    });

    const result = await runner.run(module, undefined, state, { prefix: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(failure);
      expect(result.timing.durationMs).toBe(20);
      expect(result.errorRecord).toMatchObject({
        runId: state.metadata.runId,
        module: 'research',
        errorClass: 'ProviderError',
        attemptNumber: 1,
        resolved: false,
      });
      expect(result.state.timings).toEqual([result.timing]);
      expect(result.state.errors).toEqual([result.errorRecord]);
    }
    expect(state.timings).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  it('normalizes untyped module failures and invokes failure hooks', async () => {
    const calls: string[] = [];
    const module = defineModule({
      metadata: metadata('research'),
      lifecycle: {
        onFailure: () => {
          calls.push('module:failure');
        },
      },
      execute: () => {
        throw new Error('unexpected failure');
      },
    });
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(module),
      clock: new FakeClock(),
      lifecycle: {
        onFailure: () => {
          calls.push('runner:failure');
        },
      },
    });

    const result = await runner.run(module, undefined, createInitialState(), { prefix: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('FatalError');
      expect(result.errorRecord).toMatchObject({
        errorClass: 'FatalError',
        message: 'Fatal failure in research: unexpected failure',
      });
    }
    expect(calls).toEqual(['module:failure', 'runner:failure']);
  });

  it('propagates a typed failure from a failure lifecycle hook', async () => {
    const module = defineModule({
      metadata: metadata('research'),
      lifecycle: {
        onFailure: () => {
          throw new ValidationError('research', ['failure hook must be terminal']);
        },
      },
      execute: () => {
        throw new Error('unexpected failure');
      },
    });
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(module),
      clock: new FakeClock(),
    });

    const result = await runner.run(module, undefined, createInitialState(), { prefix: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.errorRecord.errorClass).toBe('ValidationError');
    }
  });

  it('rejects execution of a module that was not registered', async () => {
    const registered = createModule('research', () => 'registered');
    const unregistered = createModule('research', () => 'unregistered');
    const runner = new ModuleRunner({
      registry: createModuleRegistry<Services>().register(registered),
      clock: new FakeClock(),
    });

    await expect(
      runner.run(unregistered, undefined, createInitialState(), { prefix: '' }),
    ).rejects.toThrow(/must be registered/);
  });
});
