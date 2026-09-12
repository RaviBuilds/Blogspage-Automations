/**
 * Tests for resumePipeline CLI
 */

import { describe, expect, it } from 'vitest';

import { type ResumeArgs, type ResumeSummary } from '@/cli/resumePipeline.js';

describe('resumePipeline CLI', () => {
  describe('ResumeArgs schema', () => {
    it('should require runId', () => {
      const validArgs: ResumeArgs = { runId: 'test-run-id' };
      expect(validArgs.runId).toBeDefined();
      expect(validArgs.runId).toBe('test-run-id');
    });

    it('should accept valid runId argument', () => {
      const args: ResumeArgs = { runId: 'another-run-id' };
      expect(args.runId).toBe('another-run-id');
    });
  });

  describe('ResumeSummary type', () => {
    it('should have correct structure for success', () => {
      const summary: ResumeSummary = {
        runId: 'test-run-id',
        status: 'success',
        topic: 'Test Topic',
        resumedFrom: ['research', 'planner'],
        completedModules: ['research', 'planner', 'writer'],
        pendingModules: [],
        totalDurationMs: 5000,
        totalCostUsd: 0.1,
      };

      expect(summary.status).toBe('success');
      expect(summary.resumedFrom.length).toBe(2);
      expect(summary.completedModules.length).toBe(3);
    });

    it('should have correct structure for failed', () => {
      const summary: ResumeSummary = {
        runId: 'failed-run-id',
        status: 'failed',
        topic: 'Failed Topic',
        resumedFrom: ['research'],
        completedModules: ['research'],
        pendingModules: ['planner', 'writer'],
        totalDurationMs: 2000,
        totalCostUsd: 0.05,
        error: 'Provider rate limit exceeded',
      };

      expect(summary.status).toBe('failed');
      expect(summary.error).toBeDefined();
    });

    it('should have correct structure for not_found', () => {
      const summary: ResumeSummary = {
        runId: 'missing-run-id',
        status: 'not_found',
        topic: 'Unknown',
        resumedFrom: [],
        completedModules: [],
        pendingModules: [],
        totalDurationMs: 0,
        totalCostUsd: 0,
        error: 'Run not found',
      };

      expect(summary.status).toBe('not_found');
    });
  });
});
