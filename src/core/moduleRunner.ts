/**
 * Registry-driven module execution framework.
 *
 * The runner owns module discovery, dependency validation, execution lifecycle,
 * immutable timing/error audit records, and typed result normalization. It does
 * not orchestrate a pipeline, select providers, or implement retries.
 *
 * @see architecture/04-json-contracts.md - state ownership and audit records
 * @see architecture/08-retry-strategy.md - retry ownership (implemented separately)
 * @see architecture/17-module-dependency-diagram.md - module dependency model
 */

import {
  appendCostEvent,
  appendErrorRecord,
  appendTimingRecord,
  type CostEvent,
  type ErrorRecord,
  type PipelineState,
  type TimingRecord,
} from '@/core/state.js';
import type { ModuleKey, ProviderName } from '@/core/types.js';
import { FatalError, ProviderError, RetryableError, ValidationError } from '@/core/errors.js';

/** A value or a promise for that value. */
export type Awaitable<T> = T | Promise<T>;

/**
 * Module capability declarations are intentionally open-ended. The runner
 * records and exposes them but does not prescribe provider or integration
 * implementations.
 */
export interface ModuleCapabilities {
  /** Capabilities this module requires from its injected dependencies. */
  readonly requires: readonly string[];
  /** Capabilities this module makes available to downstream modules. */
  readonly provides: readonly string[];
}

/** Immutable metadata every registry-discoverable module must export. */
export interface ModuleMetadata {
  /** Stable registry key shared by modules, prompts, costs, and logs. */
  readonly key: ModuleKey;
  /** Human-readable module name for logs and diagnostics. */
  readonly displayName: string;
  /** Concise statement of the module's responsibility. */
  readonly description: string;
  /** Upstream registry keys that must complete before this module may run. */
  readonly dependencies: readonly ModuleKey[];
  /** Declared dependency and output capabilities. */
  readonly capabilities: ModuleCapabilities;
}

/** Provider-call data supplied by a module without exposing audit-state ownership. */
export interface ModuleCostEventInput {
  readonly provider: ProviderName;
  readonly modelId: string;
  readonly promptVersion?: string | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
  readonly pricingVerifiedAt: string;
  readonly outcome: CostEvent['outcome'];
  readonly isImageGeneration: boolean;
}

/** Injected, immutable execution data available to a module. */
export interface ModuleExecutionContext<TServices> {
  /** The run currently being observed. */
  readonly runId: string;
  /** The registry metadata for the executing module. */
  readonly module: ModuleMetadata;
  /** Immutable PipelineState snapshot supplied by the caller. */
  readonly state: PipelineState;
  /** Dependencies supplied by the composition root. */
  readonly services: TServices;
  /** Canonical timestamp captured before lifecycle execution begins. */
  readonly startedAt: string;
  /** Reports one provider-call result for runner-owned immutable cost recording. */
  readonly recordCost: (event: ModuleCostEventInput) => void;
}

/** Event supplied to lifecycle start hooks. */
export interface ModuleExecutionStart<TInput, TServices> {
  readonly input: TInput;
  readonly context: ModuleExecutionContext<TServices>;
}

/** One successful module result, including the runner-owned state snapshot. */
export interface ModuleExecutionSuccess<TOutput> {
  readonly ok: true;
  readonly output: TOutput;
  /** State with exactly one runner-owned TimingRecord appended. */
  readonly state: PipelineState;
  readonly timing: TimingRecord;
}

/** One failed module result, including normalized error and audit state. */
export interface ModuleExecutionFailure {
  readonly ok: false;
  readonly error: ValidationError | ProviderError | RetryableError | FatalError;
  /** State with exactly one runner-owned TimingRecord and ErrorRecord appended. */
  readonly state: PipelineState;
  readonly timing: TimingRecord;
  readonly errorRecord: ErrorRecord;
}

/** Discriminated execution result propagated to a future orchestrator. */
export type ModuleExecutionResult<TOutput> =
  | ModuleExecutionSuccess<TOutput>
  | ModuleExecutionFailure;

/** Event supplied to lifecycle success hooks. */
export interface ModuleExecutionSuccessEvent<TInput, TOutput, TServices> {
  readonly input: TInput;
  readonly context: ModuleExecutionContext<TServices>;
  readonly result: ModuleExecutionSuccess<TOutput>;
}

/** Event supplied to lifecycle failure hooks. */
export interface ModuleExecutionFailureEvent<TInput, TServices> {
  readonly input: TInput;
  readonly context: ModuleExecutionContext<TServices>;
  readonly error: ValidationError | ProviderError | RetryableError | FatalError;
}

/**
 * Optional module-local lifecycle hooks. Exceptions from a hook are terminal
 * FatalErrors so they are never silently ignored.
 */
export interface ModuleLifecycleHooks<TInput, TOutput, TServices> {
  readonly onStart?:
    | ((event: ModuleExecutionStart<TInput, TServices>) => Awaitable<void>)
    | undefined;
  readonly onSuccess?:
    | ((event: ModuleExecutionSuccessEvent<TInput, TOutput, TServices>) => Awaitable<void>)
    | undefined;
  readonly onFailure?:
    | ((event: ModuleExecutionFailureEvent<TInput, TServices>) => Awaitable<void>)
    | undefined;
}

/**
 * The only interface a future module must implement. Its generic input/output
 * types remain local to the module; dependencies arrive exclusively via DI.
 */
export interface PipelineModule<TInput, TOutput, TServices> {
  readonly metadata: ModuleMetadata;
  execute(input: TInput, context: ModuleExecutionContext<TServices>): Awaitable<TOutput>;
  readonly lifecycle?: ModuleLifecycleHooks<TInput, TOutput, TServices> | undefined;
}

/** Read-only dependency graph derived from registered module metadata. */
export interface ModuleDependencyGraph {
  /** Registered keys in deterministic registration order. */
  readonly nodes: readonly ModuleKey[];
  /** Direct upstream dependencies of one module. */
  dependenciesOf(key: ModuleKey): readonly ModuleKey[];
  /** Direct downstream dependents of one module. */
  dependentsOf(key: ModuleKey): readonly ModuleKey[];
  /** A deterministic topological order over all registered modules. */
  executionOrder(): readonly ModuleKey[];
}

/** Clock abstraction keeps timing deterministic and unit-testable. */
export interface ModuleRunnerClock {
  /** Current wall-clock time used for canonical audit timestamps. */
  now(): Date;
  /** Monotonic time in milliseconds used for durations. */
  monotonicNow(): number;
}

/** Hooks invoked around every registered module execution. */
export type ModuleRunnerLifecycleHooks<TServices> = ModuleLifecycleHooks<
  unknown,
  unknown,
  TServices
>;

/** Construction options for the module runner. */
export interface ModuleRunnerOptions<TServices> {
  readonly registry: ModuleRegistry<TServices>;
  readonly lifecycle?: ModuleRunnerLifecycleHooks<TServices> | undefined;
  readonly clock?: ModuleRunnerClock | undefined;
}

type RegisteredModule<TServices> = PipelineModule<unknown, unknown, TServices>;

type ModuleFailure = ValidationError | ProviderError | RetryableError | FatalError;

const SYSTEM_CLOCK: ModuleRunnerClock = Object.freeze({
  now: (): Date => new Date(),
  monotonicNow: (): number => performance.now(),
});

/**
 * Declares a module with immutable metadata. A module may alternatively satisfy
 * PipelineModule directly; this helper prevents accidental metadata mutation.
 */
export function defineModule<TInput, TOutput, TServices>(
  module: PipelineModule<TInput, TOutput, TServices>,
): PipelineModule<TInput, TOutput, TServices> {
  return Object.freeze({
    ...module,
    metadata: freezeMetadata(module.metadata),
  });
}

/** Creates an initially empty registry for one dependency-injection container. */
export function createModuleRegistry<TServices>(): ModuleRegistry<TServices> {
  return new ModuleRegistry<TServices>();
}

/**
 * Registry-based module discovery. Registration has no execution side effect;
 * callers can register modules in any order before asking for the graph.
 */
export class ModuleRegistry<TServices> {
  private readonly modules = new Map<ModuleKey, RegisteredModule<TServices>>();

  /** Registers a module exactly once under its stable registry key. */
  public register<TInput, TOutput>(module: PipelineModule<TInput, TOutput, TServices>): this {
    const metadata = freezeMetadata(module.metadata);

    if (this.modules.has(metadata.key)) {
      throw new RangeError(`A module is already registered for key "${metadata.key}".`);
    }

    this.modules.set(metadata.key, {
      ...module,
      metadata,
    } as unknown as RegisteredModule<TServices>);

    return this;
  }

  /** Returns whether a module is registered under the supplied key. */
  public has(key: ModuleKey): boolean {
    return this.modules.has(key);
  }

  /** Retrieves one registered module for key-based discovery. */
  public get(key: ModuleKey): RegisteredModule<TServices> | undefined {
    return this.modules.get(key);
  }

  /** Retrieves one registered module or raises a clear discovery error. */
  public require(key: ModuleKey): RegisteredModule<TServices> {
    const module = this.get(key);
    if (module === undefined) {
      throw new RangeError(`No module is registered for key "${key}".`);
    }

    return module;
  }

  /** Returns immutable module metadata in deterministic registration order. */
  public list(): readonly ModuleMetadata[] {
    return Object.freeze([...this.modules.values()].map((module) => module.metadata));
  }

  /** Builds and validates the registered dependency graph on demand. */
  public dependencyGraph(): ModuleDependencyGraph {
    const dependencies = new Map<ModuleKey, readonly ModuleKey[]>();
    const dependents = new Map<ModuleKey, ModuleKey[]>();

    for (const key of this.modules.keys()) {
      dependents.set(key, []);
    }

    for (const [key, module] of this.modules.entries()) {
      const moduleDependencies = module.metadata.dependencies;
      for (const dependency of moduleDependencies) {
        if (!this.modules.has(dependency)) {
          throw new RangeError(`Module "${key}" depends on unregistered module "${dependency}".`);
        }

        const dependencyDependents = dependents.get(dependency);
        if (dependencyDependents === undefined) {
          throw new RangeError(`Registered dependency "${dependency}" is unavailable.`);
        }
        dependencyDependents.push(key);
      }
      dependencies.set(key, moduleDependencies);
    }

    const nodes = Object.freeze([...this.modules.keys()]);
    const frozenDependencies = new Map<ModuleKey, readonly ModuleKey[]>();
    const frozenDependents = new Map<ModuleKey, readonly ModuleKey[]>();
    for (const key of nodes) {
      frozenDependencies.set(key, Object.freeze([...(dependencies.get(key) ?? [])]));
      frozenDependents.set(key, Object.freeze([...(dependents.get(key) ?? [])]));
    }

    const order = Object.freeze(topologicalOrder(nodes, frozenDependencies));

    return Object.freeze({
      nodes,
      dependenciesOf: (key: ModuleKey): readonly ModuleKey[] => {
        const moduleDependencies = frozenDependencies.get(key);
        if (moduleDependencies === undefined) {
          throw new RangeError(`No module is registered for key "${key}".`);
        }
        return moduleDependencies;
      },
      dependentsOf: (key: ModuleKey): readonly ModuleKey[] => {
        const moduleDependents = frozenDependents.get(key);
        if (moduleDependents === undefined) {
          throw new RangeError(`No module is registered for key "${key}".`);
        }
        return moduleDependents;
      },
      executionOrder: (): readonly ModuleKey[] => order,
    });
  }
}

/**
 * Executes one registered module and returns its output or a normalized failure.
 * Pipeline sequencing, retry policy, status transitions, and state persistence
 * are intentionally outside this framework's responsibility.
 */
export class ModuleRunner<TServices> {
  private readonly registry: ModuleRegistry<TServices>;
  private readonly lifecycle: ModuleRunnerLifecycleHooks<TServices> | undefined;
  private readonly clock: ModuleRunnerClock;

  public constructor(options: ModuleRunnerOptions<TServices>) {
    this.registry = options.registry;
    this.lifecycle = options.lifecycle;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  /** Executes a module found by registry key when compile-time I/O is unavailable. */
  public async runByKey(
    key: ModuleKey,
    input: unknown,
    state: PipelineState,
    services: TServices,
  ): Promise<ModuleExecutionResult<unknown>> {
    return this.runRegistered(this.registry.require(key), input, state, services);
  }

  /**
   * Executes a registered module with its local input/output types preserved.
   * The module must already be registered under its metadata key.
   */
  public async run<TInput, TOutput>(
    module: PipelineModule<TInput, TOutput, TServices>,
    input: TInput,
    state: PipelineState,
    services: TServices,
  ): Promise<ModuleExecutionResult<TOutput>> {
    const registeredModule = this.registry.require(module.metadata.key);
    if (registeredModule.execute !== module.execute) {
      throw new RangeError(
        `The module for key "${module.metadata.key}" must be registered before execution.`,
      );
    }

    const result = await this.runRegistered(registeredModule, input, state, services);
    return result as ModuleExecutionResult<TOutput>;
  }

  private async runRegistered(
    module: RegisteredModule<TServices>,
    input: unknown,
    state: PipelineState,
    services: TServices,
  ): Promise<ModuleExecutionResult<unknown>> {
    const startedAt = this.timestamp();
    const startedAtMonotonic = this.monotonicTimestamp();
    const costInputs: ModuleCostEventInput[] = [];
    const context = Object.freeze({
      runId: state.metadata.runId,
      module: module.metadata,
      state,
      services,
      startedAt,
      recordCost: (event: ModuleCostEventInput): void => {
        costInputs.push(Object.freeze({ ...event }));
      },
    } satisfies ModuleExecutionContext<TServices>);
    const startEvent: ModuleExecutionStart<unknown, TServices> = Object.freeze({ input, context });

    try {
      await invokeStartHooks(this.lifecycle, module.lifecycle, startEvent);
      const output = await module.execute(input, context);
      const timing = this.createTiming(state, module.metadata.key, startedAt, startedAtMonotonic);
      const stateWithCost = this.appendCostEvents(state, module.metadata.key, costInputs, timing);
      const stateWithTiming = appendTimingRecord(stateWithCost, timing);
      const success: ModuleExecutionSuccess<unknown> = Object.freeze({
        ok: true,
        output,
        state: stateWithTiming,
        timing,
      });

      await invokeSuccessHooks(
        this.lifecycle,
        module.lifecycle,
        Object.freeze({
          input,
          context,
          result: success,
        }),
      );

      return success;
    } catch (error: unknown) {
      const normalizedError = normalizeModuleError(module.metadata.key, error);
      const failureError = await invokeFailureHooks(
        this.lifecycle,
        module.lifecycle,
        Object.freeze({ input, context, error: normalizedError }),
        module.metadata.key,
      );
      const timing = this.createTiming(state, module.metadata.key, startedAt, startedAtMonotonic);
      const stateWithTiming = appendTimingRecord(
        this.appendCostEvents(state, module.metadata.key, costInputs, timing),
        timing,
      );
      const errorRecord = Object.freeze({
        runId: state.metadata.runId,
        module: module.metadata.key,
        errorClass: failureError.name,
        attemptNumber: 1,
        message: failureError.message,
        timestamp: this.timestamp(),
        resolved: false,
      } satisfies ErrorRecord);

      return Object.freeze({
        ok: false,
        error: failureError,
        state: appendErrorRecord(stateWithTiming, errorRecord),
        timing,
        errorRecord,
      });
    }
  }

  private appendCostEvents(
    state: PipelineState,
    module: ModuleKey,
    inputs: readonly ModuleCostEventInput[],
    timing: TimingRecord,
  ): PipelineState {
    return inputs.reduce<PipelineState>(
      (nextState, input) =>
        appendCostEvent(
          nextState,
          Object.freeze({
            runId: state.metadata.runId,
            moduleKey: module,
            attemptNumber: timing.attemptNumber,
            timestamp: timing.startedAt,
            provider: input.provider,
            modelId: input.modelId,
            ...(input.promptVersion === undefined ? {} : { promptVersion: input.promptVersion }),
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cachedInputTokens: input.cachedInputTokens,
            reasoningTokens: input.reasoningTokens,
            estimatedCostUsd: input.estimatedCostUsd,
            pricingVerifiedAt: input.pricingVerifiedAt,
            latencyMs: timing.durationMs,
            outcome: input.outcome,
            isImageGeneration: input.isImageGeneration,
          } satisfies CostEvent),
        ),
      state,
    );
  }

  private createTiming(
    state: PipelineState,
    module: ModuleKey,
    startedAt: string,
    startedAtMonotonic: number,
  ): TimingRecord {
    const durationMs = Math.max(0, Math.round(this.monotonicTimestamp() - startedAtMonotonic));
    return Object.freeze({
      runId: state.metadata.runId,
      module,
      attemptNumber: 1,
      startedAt,
      durationMs,
    });
  }

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private monotonicTimestamp(): number {
    const timestamp = this.clock.monotonicNow();
    if (!Number.isFinite(timestamp)) {
      throw new RangeError('ModuleRunnerClock.monotonicNow() must return a finite number.');
    }
    return timestamp;
  }
}

function freezeMetadata(metadata: ModuleMetadata): ModuleMetadata {
  if (metadata.displayName.trim().length === 0) {
    throw new RangeError('Module metadata.displayName must not be empty.');
  }
  if (metadata.description.trim().length === 0) {
    throw new RangeError(`Module "${metadata.key}" metadata.description must not be empty.`);
  }
  if (metadata.dependencies.includes(metadata.key)) {
    throw new RangeError(`Module "${metadata.key}" cannot depend on itself.`);
  }

  return Object.freeze({
    key: metadata.key,
    displayName: metadata.displayName,
    description: metadata.description,
    dependencies: freezeUniqueValues(
      metadata.dependencies,
      `Module "${metadata.key}" dependencies`,
    ),
    capabilities: Object.freeze({
      requires: freezeUniqueValues(
        metadata.capabilities.requires,
        `Module "${metadata.key}" required capabilities`,
      ),
      provides: freezeUniqueValues(
        metadata.capabilities.provides,
        `Module "${metadata.key}" provided capabilities`,
      ),
    }),
  });
}

function freezeUniqueValues<TValue extends string>(
  values: readonly TValue[],
  field: string,
): readonly TValue[] {
  const uniqueValues = new Set<TValue>();
  for (const value of values) {
    if (value.trim().length === 0) {
      throw new RangeError(`${field} must not contain empty values.`);
    }
    if (uniqueValues.has(value)) {
      throw new RangeError(`${field} must not contain duplicate value "${value}".`);
    }
    uniqueValues.add(value);
  }

  return Object.freeze([...values]);
}

function topologicalOrder(
  nodes: readonly ModuleKey[],
  dependencies: ReadonlyMap<ModuleKey, readonly ModuleKey[]>,
): ModuleKey[] {
  const visiting = new Set<ModuleKey>();
  const visited = new Set<ModuleKey>();
  const order: ModuleKey[] = [];
  const trail: ModuleKey[] = [];

  const visit = (key: ModuleKey): void => {
    if (visited.has(key)) {
      return;
    }
    if (visiting.has(key)) {
      const cycleStart = trail.indexOf(key);
      const cycle = [...trail.slice(cycleStart), key];
      throw new RangeError(`Module dependency cycle detected: ${cycle.join(' -> ')}.`);
    }

    visiting.add(key);
    trail.push(key);
    const moduleDependencies = dependencies.get(key);
    if (moduleDependencies === undefined) {
      throw new RangeError(`No dependency metadata is available for module "${key}".`);
    }
    for (const dependency of moduleDependencies) {
      visit(dependency);
    }
    trail.pop();
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  };

  for (const key of nodes) {
    visit(key);
  }

  return order;
}

function normalizeModuleError(moduleKey: ModuleKey, error: unknown): ModuleFailure {
  if (
    error instanceof ValidationError ||
    error instanceof ProviderError ||
    error instanceof RetryableError ||
    error instanceof FatalError
  ) {
    return error;
  }

  const reason = error instanceof Error ? error.message : String(error);
  return new FatalError(moduleKey, reason);
}

async function invokeStartHooks<TServices>(
  runnerHooks: ModuleRunnerLifecycleHooks<TServices> | undefined,
  moduleHooks: ModuleLifecycleHooks<unknown, unknown, TServices> | undefined,
  event: ModuleExecutionStart<unknown, TServices>,
): Promise<void> {
  await runnerHooks?.onStart?.(event);
  await moduleHooks?.onStart?.(event);
}

async function invokeSuccessHooks<TServices>(
  runnerHooks: ModuleRunnerLifecycleHooks<TServices> | undefined,
  moduleHooks: ModuleLifecycleHooks<unknown, unknown, TServices> | undefined,
  event: ModuleExecutionSuccessEvent<unknown, unknown, TServices>,
): Promise<void> {
  await moduleHooks?.onSuccess?.(event);
  await runnerHooks?.onSuccess?.(event);
}

async function invokeFailureHooks<TServices>(
  runnerHooks: ModuleRunnerLifecycleHooks<TServices> | undefined,
  moduleHooks: ModuleLifecycleHooks<unknown, unknown, TServices> | undefined,
  event: ModuleExecutionFailureEvent<unknown, TServices>,
  moduleKey: ModuleKey,
): Promise<ModuleFailure> {
  try {
    await moduleHooks?.onFailure?.(event);
    await runnerHooks?.onFailure?.(event);
    return event.error;
  } catch (error: unknown) {
    return normalizeModuleError(moduleKey, error);
  }
}
