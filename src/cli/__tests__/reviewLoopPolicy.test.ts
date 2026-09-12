/** Tests for the bounded review-loop policy. */

import { describe, expect, it } from 'vitest';

import { createReviewLoopPolicy, REVIEW_CYCLE_KEYS } from '@/cli/reviewLoopPolicy.js';
import {
  createInitialState,
  setReviewLoopIteration,
  type PipelineState,
  type QaSection,
} from '@/core/state.js';
import type { Config } from '@/core/types.js';

function config(runSet: 'full' | 'budget' | 'minimum'): Config {
  return {
    runSet,
    pipeline: { maxReviewIterations: 3 },
  } as unknown as Config;
}

function stateWithQa(decision: QaSection['decision'], iteration: number): PipelineState {
  return setReviewLoopIteration(
    { ...createInitialState(), qa: { decision, remainingIssues: [] } },
    iteration,
  );
}

describe('createReviewLoopPolicy', () => {
  it('is undefined outside the full run-set (human review replaces the AI loop)', () => {
    expect(createReviewLoopPolicy(config('budget'))).toBeUndefined();
    expect(createReviewLoopPolicy(config('minimum'))).toBeUndefined();
  });

  it('reruns the review cycle on needsRevision while iterations remain', () => {
    const policy = createReviewLoopPolicy(config('full'));
    expect(policy).toBeDefined();
    if (policy === undefined) return;

    const decision = policy(stateWithQa('needsRevision', 0), 'qa');
    expect(decision?.action).toBe('rerun');
    if (decision?.action !== 'rerun') return;
    expect(decision.iteration).toBe(1);
    expect(decision.cycleKeys).toEqual(REVIEW_CYCLE_KEYS);
    expect(decision.state.review?.loop?.iteration).toBe(1);
  });

  it('fails closed when the iteration budget is exhausted', () => {
    const policy = createReviewLoopPolicy(config('full'));
    if (policy === undefined) return;

    expect(policy(stateWithQa('needsRevision', 3), 'qa')).toEqual({ action: 'failClosed' });
  });

  it('fails closed on an explicit failClosed decision', () => {
    const policy = createReviewLoopPolicy(config('full'));
    if (policy === undefined) return;

    expect(policy(stateWithQa('failClosed', 1), 'qa')).toEqual({ action: 'failClosed' });
  });

  it('passes through on a pass decision and ignores other modules', () => {
    const policy = createReviewLoopPolicy(config('full'));
    if (policy === undefined) return;

    expect(policy(stateWithQa('pass', 0), 'qa')).toBeUndefined();
    expect(policy(stateWithQa('pass', 0), 'humanizer')).toBeUndefined();
  });
});
