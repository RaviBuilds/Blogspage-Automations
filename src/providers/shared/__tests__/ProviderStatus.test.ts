import { describe, expect, it } from 'vitest';

import { ProviderHealthTracker } from '@/providers/shared/ProviderStatus.js';

describe('ProviderHealthTracker', () => {
  it('starts healthy with no history and availability 1', () => {
    const tracker = new ProviderHealthTracker(
      'anthropic',
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    const status = tracker.getStatus();

    expect(status).toEqual({
      providerName: 'anthropic',
      health: 'healthy',
      lastSuccessAt: undefined,
      lastFailureAt: undefined,
      lastLatencyMs: undefined,
      consecutiveFailures: 0,
      availability: 1,
      quota: undefined,
    });
  });

  it('records a success and resets consecutive failures', () => {
    const tracker = new ProviderHealthTracker('openai', () => new Date('2026-01-01T00:00:00.000Z'));

    tracker.recordFailure(50);
    tracker.recordSuccess(120, {
      remaining: 100,
      limit: 1000,
      resetAt: '2026-01-02T00:00:00.000Z',
    });

    const status = tracker.getStatus();
    expect(status.health).toBe('healthy');
    expect(status.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z');
    expect(status.lastLatencyMs).toBe(120);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.quota).toEqual({
      remaining: 100,
      limit: 1000,
      resetAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('classifies health as degraded after 1-2 consecutive failures, unavailable at 3+', () => {
    const tracker = new ProviderHealthTracker('gemini');

    tracker.recordFailure(10);
    expect(tracker.getStatus().health).toBe('degraded');

    tracker.recordFailure(10);
    expect(tracker.getStatus().health).toBe('degraded');

    tracker.recordFailure(10);
    expect(tracker.getStatus().health).toBe('unavailable');
    expect(tracker.getStatus().consecutiveFailures).toBe(3);
  });

  it('computes availability as a rolling ratio over the most recent calls', () => {
    const tracker = new ProviderHealthTracker('openrouter');

    tracker.recordSuccess(10);
    tracker.recordSuccess(10);
    tracker.recordFailure(10);
    tracker.recordSuccess(10);

    expect(tracker.getStatus().availability).toBe(0.75);
  });

  it('bounds the availability window so old outcomes age out', () => {
    const tracker = new ProviderHealthTracker('local');

    for (let index = 0; index < 20; index += 1) {
      tracker.recordFailure(10);
    }
    expect(tracker.getStatus().availability).toBe(0);

    for (let index = 0; index < 20; index += 1) {
      tracker.recordSuccess(10);
    }
    expect(tracker.getStatus().availability).toBe(1);
  });

  it('returns an immutable status snapshot', () => {
    const tracker = new ProviderHealthTracker('anthropic');
    expect(Object.isFrozen(tracker.getStatus())).toBe(true);
  });
});
