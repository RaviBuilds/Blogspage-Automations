/**
 * Registry-driven pipeline coordination.
 *
 * The orchestrator resolves execution order from ModuleRegistry, delegates every
 * invocation to ModuleRunner, persists immutable checkpoints, and owns pipeline
 * lifecycle status transitions. Module-specific inputs and state writes remain
 * injected bindings so this layer never depends on module implementations.
 *
 * @see architecture/03-module-flow.md - orchestration responsibilities
 * @see architecture/04-json-contracts.md - PipelineState ownership
 * @see architecture/17-module-dependency-diagram.md - dependency ordering
 */

import { FatalError } from '@/core/errors.js';
import {
  type ModuleDependencyGraph,
  type ModuleExecutionFailure,
  type ModuleRunner,
  type ModuleMetadata,
  type ModuleRegistry,
} from '@/core/moduleRunner.js';
import {
  setPipelineStatus,
  type PipelineState,
  type PipelineStatus,
  type TimingRecord,
} from '@/core/state.js';
import type { ModuleKey } from '@/core/types.js';

/** Persistence boundary required for immutable orchestration checkpoints. */
export interface PipelineStateCheckpointStore {
  save(state: PipelineState, suffix?: string): Promise<void>;
}

/** A resumable checkpoint derived from persisted runner audit records. */
export interface OrchestrationResumePoint {
  /** Modules known to have completed successfully in the persisted snapshot. */
  readonly completed: readonly ModuleKey[];
  /** Modules that remain eligible for execution in dependency order. */
  readonly pending: readonly ModuleKey[];
  /** The next module to invoke, or undefined when the schedule is complete. */
  readonly next: ModuleKey | undefined;
}

/** Immutable services and state supplied to orchestration-owned bindings. */
export interface OrchestratorExecutionContext<TServices> {
  readonly runId: string;
  readonly module: ModuleMetadata;
  readonly state: PipelineState;
  readonly services: TServices;
  readonly registry: ModuleRegistry<TServices>;
  readonly dependencyGraph: ModuleDependencyGraph;
  readonly executionOrder: readonly ModuleKey[];
  readonly resumePoint: OrchestrationResumePoint;
}

/**
 * Module-local adaptation supplied by the composition root.
 *
 * A binding translates only between a module's opaque input/output and the
 * shared state contract. The orchestrator never calls a module from this
 * binding; all execution still passes through ModuleRunner.runByKey().
 */
export interface OrchestratorModuleBinding<TServices> {
  readonly key: ModuleKey;
  createInput(state: PipelineState, context: OrchestratorExecutionContext<TServices>): unknown;
  applyOutput(
    state: PipelineState,
    output: unknown,
    context: OrchestratorExecutionContext<TServices>,
  ): PipelineState;
}

/** Configuration for dependency-injected orchestration. */
export interface PipelineOrchestratorOptions<TServices> {
  readonly registry: ModuleRegistry<TServices>;
  readonly runner: ModuleRunner<TServices>;
  readonly stateStore: PipelineStateCheckpointStore;
  readonly services: TServices;
  readonly bindings: readonly OrchestratorModuleBinding<TServices>[];
  /**
   * Optional human-in-the-loop checkpoint hook (`21-cost-budget-modes-human-in-loop.md`).
   * After each successful module, when this hook returns a status the orchestrator
   * transitions the run to that status, checkpoints it, and stops instead of
   * continuing — a clean pause (e.g. `awaiting_assets`), never a failure. The hook
   * is supplied by the composition root, so the orchestrator stays config-agnostic.
   */
  readonly pauseAfter?: ((state: PipelineState) => PipelineStatus | undefined) | undefined;
}

/** A lifecycle event retained in the typed result for audit consumers. */
export interface PipelineRunStartedEvent {
  readonly type: 'pipeline.started';
  readonly runId: string;
  readonly state: PipelineState;
  readonly resumePoint: OrchestrationResumePoint;
}

/** A module was selected by the dependency scheduler. */
export interface PipelineModuleStartedEvent {
  readonly type: 'module.started';
  readonly runId: string;
  readonly module: ModuleKey;
  readonly state: PipelineState;
}

/** A module completed and its state transition was checkpointed. */
export interface PipelineModuleSucceededEvent {
  readonly type: 'module.succeeded';
  readonly runId: string;
  readonly module: ModuleKey;
  readonly state: PipelineState;
  readonly timing: TimingRecord;
}

/** A ModuleRunner failure halted the pipeline before downstream work began. */
export interface PipelineModuleFailedEvent {
  readonly type: 'module.failed';
  readonly runId: string;
  readonly module: ModuleKey;
  readonly state: PipelineState;
  readonly failure: ModuleExecutionFailure;
}

/** A terminal state checkpoint was written. */
export interface PipelineCompletedEvent {
  readonly type: 'pipeline.completed';
  readonly runId: string;
  readonly state: PipelineState;
}

/** A checkpoint pause was requested and the run stopped with a status. */
export interface PipelinePausedEvent {
  readonly type: 'pipeline.paused';
  readonly runId: string;
  readonly status: PipelineStatus;
  readonly state: PipelineState;
}

/** Ordered audit events produced during one orchestrator invocation. */
export type PipelineExecutionEvent =
  | PipelineRunStartedEvent
  | PipelineModuleStartedEvent
  | PipelineModuleSucceededEvent
  | PipelineModuleFailedEvent
  | PipelineCompletedEvent
  | PipelinePausedEvent;

/** One successful runner invocation and its state transition. */
export interface OrchestratedModuleSuccess {
  readonly module: ModuleKey;
  readonly output: unknown;
  readonly timing: TimingRecord;
  readonly state: PipelineState;
}

/** Typed successful pipeline completion. */
export interface OrchestrationSuccess {
  readonly ok: true;
  readonly state: PipelineState;
  readonly resumePoint: OrchestrationResumePoint;
  readonly executions: readonly OrchestratedModuleSuccess[];
  readonly events: readonly PipelineExecutionEvent[];
}

/** Typed stop-on-failure result from a module invocation. */
export interface OrchestrationModuleFailure {
  readonly ok: false;
  readonly kind: 'module-failure';
  readonly module: ModuleKey;
  readonly error: ModuleExecutionFailure['error'];
  readonly state: PipelineState;
  readonly resumePoint: OrchestrationResumePoint;
  readonly executions: readonly OrchestratedModuleSuccess[];
  readonly events: readonly PipelineExecutionEvent[];
}

/** Typed stop-on-pause result (human-in-the-loop checkpoint, e.g. awaiting_assets). */
export interface OrchestrationPaused {
  readonly ok: false;
  readonly kind: 'paused';
  readonly status: PipelineStatus;
  readonly state: PipelineState;
  readonly resumePoint: OrchestrationResumePoint;
  readonly executions: readonly OrchestratedModuleSuccess[];
  readonly events: readonly PipelineExecutionEvent[];
}

/** Typed failure raised by scheduling, binding, checkpoint, or lifecycle work. */
export interface OrchestrationFailure {
  readonly ok: false;
  readonly kind: 'orchestration-failure';
  readonly error: FatalError;
  readonly state: PipelineState;
  readonly executions: readonly OrchestratedModuleSuccess[];
  readonly events: readonly PipelineExecutionEvent[];
}

/** Discriminated final result of a pipeline orchestration attempt. */
export type OrchestrationResult =
  | OrchestrationSuccess
  | OrchestrationModuleFailure
  | OrchestrationFailure
  | OrchestrationPaused;

interface ExecutionSchedule<TServices> {
  readonly graph: ModuleDependencyGraph;
  readonly order: readonly ModuleKey[];
  readonly bindings: ReadonlyMap<ModuleKey, OrchestratorModuleBinding<TServices>>;
}

/**
 * Coordinates a registered pipeline without knowing how any module works.
 *
 * Each successful module receives a persisted checkpoint. A runner failure
 * appends its existing audit records, transitions the run to `failed`, stores a
 * failed checkpoint, and prevents all downstream invocation.
 */
export class PipelineOrchestrator<TServices> {
  private readonly registry: ModuleRegistry<TServices>;
  private readonly runner: ModuleRunner<TServices>;
  private readonly stateStore: PipelineStateCheckpointStore;
  private readonly services: TServices;
  private readonly bindings: ReadonlyMap<ModuleKey, OrchestratorModuleBinding<TServices>>;
  private readonly pauseAfter: ((state: PipelineState) => PipelineStatus | undefined) | undefined;

  public constructor(options: PipelineOrchestratorOptions<TServices>) {
    this.registry = options.registry;
    this.runner = options.runner;
    this.stateStore = options.stateStore;
    this.services = options.services;
    this.bindings = createBindingMap(options.bindings);
    this.pauseAfter = options.pauseAfter;
  }

  /**
   * Returns the dependency-validated execution order registered at invocation
   * time. The registry remains the single source of truth for scheduling.
   */
  public executionOrder(): readonly ModuleKey[] {
    return this.createSchedule().order;
  }

  /**
   * Prepares a resume point from durable runner timing/error audit records.
   * Only successfully completed modules are skipped; unresolved failures are
   * never treated as completed work.
   */
  public prepareResumePoint(state: PipelineState): OrchestrationResumePoint {
    const schedule = this.createSchedule();
    return prepareResumePoint(state, schedule.graph, schedule.order);
  }

  /** Executes every pending registered module in dependency order. */
  public async execute(initialState: PipelineState): Promise<OrchestrationResult> {
    const events: PipelineExecutionEvent[] = [];
    const executions: OrchestratedModuleSuccess[] = [];
    let state = initialState;

    try {
      ensureRunningState(state);
      const schedule = this.createSchedule();
      const resumePoint = prepareResumePoint(state, schedule.graph, schedule.order);
      const completed = new Set<ModuleKey>(resumePoint.completed);

      this.emit(events, {
        type: 'pipeline.started',
        runId: state.metadata.runId,
        state,
        resumePoint,
      });

      for (const key of resumePoint.pending) {
        ensureDependenciesCompleted(key, schedule.graph, completed);
        const binding = requireBinding(schedule.bindings, key);
        const module = this.registry.require(key);
        const context = this.createContext(module.metadata, state, schedule, resumePoint);
        const input = binding.createInput(state, context);

        this.emit(events, {
          type: 'module.started',
          runId: state.metadata.runId,
          module: key,
          state,
        });

        const result = await this.runner.runByKey(key, input, state, this.services);
        if (!result.ok) {
          state = setPipelineStatus(result.state, 'failed');
          await this.persistTerminalState(state, 'failed');
          this.emit(events, {
            type: 'module.failed',
            runId: state.metadata.runId,
            module: key,
            state,
            failure: result,
          });
          this.emit(events, { type: 'pipeline.completed', runId: state.metadata.runId, state });

          return Object.freeze({
            ok: false,
            kind: 'module-failure',
            module: key,
            error: result.error,
            state,
            resumePoint,
            executions: Object.freeze([...executions]),
            events: Object.freeze([...events]),
          });
        }

        state = result.state;
        const nextState = binding.applyOutput(state, result.output, context);
        assertBindingState(state, nextState, key);
        state = nextState;
        await this.stateStore.save(state);
        completed.add(key);
        const execution = Object.freeze({
          module: key,
          output: result.output,
          timing: result.timing,
          state,
        } satisfies OrchestratedModuleSuccess);
        executions.push(execution);
        this.emit(events, {
          type: 'module.succeeded',
          runId: state.metadata.runId,
          module: key,
          state,
          timing: result.timing,
        });

        const pauseStatus = this.pauseAfter?.(state);
        if (pauseStatus !== undefined) {
          const pausedState = setPipelineStatus(state, pauseStatus);
          await this.stateStore.save(pausedState);
          this.emit(events, {
            type: 'pipeline.paused',
            runId: pausedState.metadata.runId,
            status: pauseStatus,
            state: pausedState,
          });

          return Object.freeze({
            ok: false,
            kind: 'paused',
            status: pauseStatus,
            state: pausedState,
            resumePoint: prepareResumePoint(pausedState, schedule.graph, schedule.order),
            executions: Object.freeze([...executions]),
            events: Object.freeze([...events]),
          });
        }
      }

      state = setPipelineStatus(state, 'published');
      await this.persistTerminalState(state, 'completed');
      this.emit(events, { type: 'pipeline.completed', runId: state.metadata.runId, state });

      return Object.freeze({
        ok: true,
        state,
        resumePoint,
        executions: Object.freeze([...executions]),
        events: Object.freeze([...events]),
      });
    } catch (error: unknown) {
      const failure = normalizeOrchestrationError(error);
      const failedState =
        state.metadata.status === 'running' ? setPipelineStatus(state, 'failed') : state;

      try {
        await this.persistTerminalState(failedState, 'failed');
      } catch {
        // The original persistence error is retained as the orchestration failure.
      }

      this.emit(events, {
        type: 'pipeline.completed',
        runId: failedState.metadata.runId,
        state: failedState,
      });

      return Object.freeze({
        ok: false,
        kind: 'orchestration-failure',
        error: failure,
        state: failedState,
        executions: Object.freeze([...executions]),
        events: Object.freeze([...events]),
      });
    }
  }

  private createSchedule(): ExecutionSchedule<TServices> {
    const graph = this.registry.dependencyGraph();
    const order = graph.executionOrder();
    const graphKeys = new Set<ModuleKey>(graph.nodes);
    const missingBindings = order.filter((key) => !this.bindings.has(key));
    const extraBindings = [...this.bindings.keys()].filter((key) => !graphKeys.has(key));

    if (missingBindings.length > 0 || extraBindings.length > 0) {
      throw new RangeError(
        `Orchestrator bindings must match the registry exactly. Missing: ${formatKeys(
          missingBindings,
        )}; extra: ${formatKeys(extraBindings)}.`,
      );
    }

    return Object.freeze({ graph, order, bindings: this.bindings });
  }

  private createContext(
    module: ModuleMetadata,
    state: PipelineState,
    schedule: ExecutionSchedule<TServices>,
    resumePoint: OrchestrationResumePoint,
  ): OrchestratorExecutionContext<TServices> {
    return Object.freeze({
      runId: state.metadata.runId,
      module,
      state,
      services: this.services,
      registry: this.registry,
      dependencyGraph: schedule.graph,
      executionOrder: schedule.order,
      resumePoint,
    });
  }

  private async persistTerminalState(
    state: PipelineState,
    suffix: 'completed' | 'failed',
  ): Promise<void> {
    await this.stateStore.save(state);
    await this.stateStore.save(state, suffix);
  }

  private emit(events: PipelineExecutionEvent[], event: PipelineExecutionEvent): void {
    events.push(Object.freeze(event));
  }
}

function createBindingMap<TServices>(
  bindings: readonly OrchestratorModuleBinding<TServices>[],
): ReadonlyMap<ModuleKey, OrchestratorModuleBinding<TServices>> {
  const bindingMap = new Map<ModuleKey, OrchestratorModuleBinding<TServices>>();

  for (const binding of bindings) {
    if (bindingMap.has(binding.key)) {
      throw new RangeError(`An orchestrator binding already exists for key "${binding.key}".`);
    }
    bindingMap.set(binding.key, Object.freeze(binding));
  }

  return bindingMap;
}

function prepareResumePoint(
  state: PipelineState,
  graph: ModuleDependencyGraph,
  order: readonly ModuleKey[],
): OrchestrationResumePoint {
  const completed = order.filter((key) => hasCompletedModuleExecution(state, key));
  const completedSet = new Set<ModuleKey>(completed);

  for (const key of completed) {
    ensureDependenciesCompleted(key, graph, completedSet);
  }

  const pending = order.filter((key) => !completedSet.has(key));
  return Object.freeze({
    completed: Object.freeze(completed),
    pending: Object.freeze(pending),
    next: pending[0],
  });
}

function hasCompletedModuleExecution(state: PipelineState, module: ModuleKey): boolean {
  const recordedTiming = state.timings.some((timing) => timing.module === module);
  if (!recordedTiming) {
    return false;
  }

  return !state.errors.some((error) => error.module === module && !error.resolved);
}

function ensureDependenciesCompleted(
  key: ModuleKey,
  graph: ModuleDependencyGraph,
  completed: ReadonlySet<ModuleKey>,
): void {
  const missing = graph.dependenciesOf(key).filter((dependency) => !completed.has(dependency));
  if (missing.length > 0) {
    throw new RangeError(
      `Module "${key}" cannot run before completed dependencies: ${formatKeys(missing)}.`,
    );
  }
}

function requireBinding<TServices>(
  bindings: ReadonlyMap<ModuleKey, OrchestratorModuleBinding<TServices>>,
  key: ModuleKey,
): OrchestratorModuleBinding<TServices> {
  const binding = bindings.get(key);
  if (binding === undefined) {
    throw new RangeError(`No orchestrator binding is registered for key "${key}".`);
  }

  return binding;
}

function assertBindingState(previous: PipelineState, next: PipelineState, key: ModuleKey): void {
  if (next.metadata.runId !== previous.metadata.runId) {
    throw new RangeError(`Module binding "${key}" must preserve PipelineState.metadata.runId.`);
  }
  if (next.metadata.status !== previous.metadata.status) {
    throw new RangeError(`Module binding "${key}" must not change PipelineState.metadata.status.`);
  }
}

function ensureRunningState(state: PipelineState): void {
  if (state.metadata.status !== 'running') {
    throw new RangeError(
      `Pipeline run "${state.metadata.runId}" cannot execute from status "${state.metadata.status}".`,
    );
  }
}

function normalizeOrchestrationError(error: unknown): FatalError {
  if (error instanceof FatalError) {
    return error;
  }

  const reason = error instanceof Error ? error.message : String(error);
  return new FatalError('orchestrator', reason);
}

function formatKeys(keys: readonly ModuleKey[]): string {
  return keys.length === 0 ? 'none' : keys.join(', ');
}
