/**
 * Provider health bookkeeping (09-provider-abstraction.md's "Provider Health
 * Monitoring" section). This is local, per-adapter-instance bookkeeping only —
 * no orchestration, failover, or circuit-breaking logic lives here or anywhere
 * else in Phase 4. Nothing in this module makes a network call or depends on
 * any other provider file; every adapter that chooses to track health updates
 * its own status after each call using the pure helpers below.
 */

/** A provider adapter's own view of its recent call health. */
export interface ProviderStatus {
  readonly providerName: string;
  readonly health: 'healthy' | 'degraded' | 'unavailable';
  readonly lastSuccessAt: string | undefined;
  readonly lastFailureAt: string | undefined;
  readonly lastLatencyMs: number | undefined;
  readonly consecutiveFailures: number;
  readonly availability: number;
  readonly quota: ProviderQuota | undefined;
}

/** Optional quota/rate-limit information, populated only where a provider exposes it. */
export interface ProviderQuota {
  readonly remaining: number | undefined;
  readonly limit: number | undefined;
  readonly resetAt: string | undefined;
}

/** Implemented optionally by any LLMProvider/ImageProvider adapter that tracks its own health. */
export interface ProviderHealthReporter {
  getStatus(): ProviderStatus;
}

/** Bounded recent-call outcome window backing the `availability` ratio. */
const AVAILABILITY_WINDOW_SIZE = 20;

/**
 * Mutable, per-adapter-instance health tracker. Adapters compose this rather
 * than reimplementing the same bookkeeping, while still owning their own
 * `getStatus()` so this class itself never becomes a second public interface.
 */
export class ProviderHealthTracker {
  private health: ProviderStatus['health'] = 'healthy';
  private lastSuccessAt: string | undefined;
  private lastFailureAt: string | undefined;
  private lastLatencyMs: number | undefined;
  private consecutiveFailures = 0;
  private quota: ProviderQuota | undefined;
  private readonly recentOutcomes: boolean[] = [];

  public constructor(
    private readonly providerName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records a successful call. */
  public recordSuccess(latencyMs: number, quota?: ProviderQuota): void {
    this.lastSuccessAt = this.now().toISOString();
    this.lastLatencyMs = latencyMs;
    this.consecutiveFailures = 0;
    this.quota = quota;
    this.pushOutcome(true);
    this.health = 'healthy';
  }

  /** Records a failed call. */
  public recordFailure(latencyMs: number): void {
    this.lastFailureAt = this.now().toISOString();
    this.lastLatencyMs = latencyMs;
    this.consecutiveFailures += 1;
    this.pushOutcome(false);
    this.health = this.classifyHealth();
  }

  /** Returns the current, immutable status snapshot. */
  public getStatus(): ProviderStatus {
    return Object.freeze({
      providerName: this.providerName,
      health: this.health,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastLatencyMs: this.lastLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
      availability: this.computeAvailability(),
      quota: this.quota,
    });
  }

  private pushOutcome(succeeded: boolean): void {
    this.recentOutcomes.push(succeeded);
    if (this.recentOutcomes.length > AVAILABILITY_WINDOW_SIZE) {
      this.recentOutcomes.shift();
    }
  }

  private computeAvailability(): number {
    if (this.recentOutcomes.length === 0) {
      return 1;
    }

    const successes = this.recentOutcomes.filter(Boolean).length;
    return successes / this.recentOutcomes.length;
  }

  private classifyHealth(): ProviderStatus['health'] {
    if (this.consecutiveFailures >= 3) {
      return 'unavailable';
    }

    if (this.consecutiveFailures >= 1) {
      return 'degraded';
    }

    return 'healthy';
  }
}
