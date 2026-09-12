/**
 * The bounded review-loop policy (FULL run-set) shared by the run/resume roots.
 *
 * Per `architecture/21-cost-budget-modes-human-in-loop.md` and `architecture/12`,
 * quality layers (reviewer-seo, qa, improver) belong to the FULL run-set. The QA
 * Gate is the bounded-loop gatekeeper: `needsRevision` re-runs the review cycle
 * (improver → reviewers → humanizer → qa) up to `maxIterations`; `failClosed`
 * pauses the run at `needs_review` for a human. The orchestrator stays
 * domain-agnostic — this file decides, the orchestrator re-schedules.
 */

import type { OrchestratorLoopDecision } from '@/core/orchestrator.js';
import { setReviewLoopIteration, type PipelineState } from '@/core/state.js';
import type { Config, ModuleKey } from '@/core/types.js';

/** The review cycle that re-runs when QA demands another revision pass. */
export const REVIEW_CYCLE_KEYS: readonly ModuleKey[] = Object.freeze([
  'improver',
  'reviewer-technical',
  'reviewer-seo',
  'humanizer',
  'qa',
] as const);

/** Hard cap matching `pipeline.maxReviewIterations` (`core/types.ts`). */
export const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

/** How many review iterations a run may spend before QA must fail closed. */
export function maxReviewIterations(config: Config): number {
  return config.pipeline.maxReviewIterations;
}

/**
 * Builds the orchestrator loop hook, or `undefined` for run-sets that replace
 * the AI review loop with human review (budget/minimum).
 */
export function createReviewLoopPolicy(
  config: Config,
):
  | ((state: PipelineState, moduleKey: ModuleKey) => OrchestratorLoopDecision | undefined)
  | undefined {
  if (config.runSet !== 'full') {
    return undefined;
  }

  return (state, moduleKey) => {
    if (moduleKey !== 'qa') {
      return undefined;
    }
    const decision = state.qa?.decision;
    if (decision === undefined) {
      return undefined;
    }

    if (decision === 'pass') {
      return undefined;
    }

    if (decision === 'needsRevision') {
      const iteration = state.review?.loop?.iteration ?? 0;
      if (iteration < maxReviewIterations(config)) {
        return Object.freeze({
          action: 'rerun' as const,
          state: setReviewLoopIteration(state, iteration + 1),
          iteration: iteration + 1,
          cycleKeys: REVIEW_CYCLE_KEYS,
        });
      }
      return Object.freeze({ action: 'failClosed' as const });
    }

    return Object.freeze({ action: 'failClosed' as const });
  };
}
