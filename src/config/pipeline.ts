import type { PipelineConfig } from '@/core/types.js';

/**
 * Conservative defaults for bounded retries, review loops, and image work.
 * Retry orchestration itself is introduced in Phase 7.
 */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = Object.freeze({
  backoff: Object.freeze({
    baseDelayMs: 500,
    maxDelayMs: 8_000,
    jitterRatio: 0.2,
  }),
  maxImageRetries: 2,
  maxReviewIterations: 3,
  maxConcurrentImageGenerations: 4,
});
