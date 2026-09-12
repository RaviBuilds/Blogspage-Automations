/**
 * Tests for listRuns CLI
 */

import { describe, expect, it } from 'vitest';

import { createRunSummary, type ListRunsArgs, type RunSummary } from '@/cli/listRuns.js';
import { type PipelineState } from '@/core/state.js';

describe('listRuns CLI', () => {
  describe('createRunSummary', () => {
    it('should create summary from completed state', () => {
      const state: PipelineState = {
        metadata: {
          runId: 'test-run-id',
          startedAt: '2024-01-15T10:30:00.000Z',
          sheetRowId: 'row-1',
          status: 'published',
          locale: 'en',
          targetSite: 'blogspage',
        },
        brief: {
          topic: 'Test Topic',
          sheetRowId: 'row-1',
        },
        metrics: {
          costEvents: [
            {
              runId: 'test-run-id',
              moduleKey: 'research',
              attemptNumber: 1,
              timestamp: '2024-01-15T10:31:00.000Z',
              provider: 'anthropic',
              modelId: 'haiku',
              inputTokens: 1,
              outputTokens: 1,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              estimatedCostUsd: 0.05,
              pricingVerifiedAt: '2024-01-01',
              latencyMs: 100,
              outcome: 'success',
              isImageGeneration: false,
            },
            {
              runId: 'test-run-id',
              moduleKey: 'planner',
              attemptNumber: 1,
              timestamp: '2024-01-15T10:32:00.000Z',
              provider: 'anthropic',
              modelId: 'haiku',
              inputTokens: 1,
              outputTokens: 1,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              estimatedCostUsd: 0.03,
              pricingVerifiedAt: '2024-01-01',
              latencyMs: 90,
              outcome: 'success',
              isImageGeneration: false,
            },
          ],
          totalCostUsd: 0.08,
        },
        timings: [
          {
            runId: 'test-run-id',
            module: 'research',
            attemptNumber: 1,
            startedAt: '2024-01-15T10:30:00.000Z',
            durationMs: 5000,
          },
          {
            runId: 'test-run-id',
            module: 'planner',
            attemptNumber: 1,
            startedAt: '2024-01-15T10:30:05.000Z',
            durationMs: 3000,
          },
        ],
        errors: [],
      };

      const summary = createRunSummary(state);

      expect(summary.runId).toBe('test-run-id');
      expect(summary.status).toBe('published');
      expect(summary.topic).toBe('Test Topic');
      expect(summary.totalCostUsd).toBe(0.08);
      expect(summary.moduleCount).toBe(2);
      expect(summary.durationMs).toBe(8000);
    });

    it('should create summary from failed state', () => {
      const state: PipelineState = {
        metadata: {
          runId: 'failed-run-id',
          startedAt: '2024-01-15T10:30:00.000Z',
          sheetRowId: 'row-2',
          status: 'failed',
          locale: 'en',
          targetSite: 'blogspage',
        },
        brief: {
          topic: 'Failed Topic',
          sheetRowId: 'row-2',
        },
        metrics: {
          costEvents: [],
          totalCostUsd: 0.02,
        },
        timings: [
          {
            runId: 'failed-run-id',
            module: 'research',
            attemptNumber: 1,
            startedAt: '2024-01-15T10:30:00.000Z',
            durationMs: 2000,
          },
        ],
        errors: [
          {
            runId: 'failed-run-id',
            module: 'planner',
            errorClass: 'ProviderError',
            attemptNumber: 1,
            message: 'API rate limit exceeded',
            timestamp: '2024-01-15T10:35:00.000Z',
            resolved: false,
          },
        ],
      };

      const summary = createRunSummary(state);

      expect(summary.runId).toBe('failed-run-id');
      expect(summary.status).toBe('failed');
      expect(summary.topic).toBe('Failed Topic');
      expect(summary.moduleCount).toBe(1);
      expect(summary.error).toBe('API rate limit exceeded');
    });

    it('should handle state without brief', () => {
      const state: PipelineState = {
        metadata: {
          runId: 'no-brief-run',
          startedAt: '2024-01-15T10:30:00.000Z',
          sheetRowId: 'row-3',
          status: 'running',
          locale: 'en',
          targetSite: 'blogspage',
        },
        metrics: {
          costEvents: [],
          totalCostUsd: 0,
        },
        timings: [],
        errors: [],
      };

      const summary = createRunSummary(state);

      expect(summary.topic).toBe('No topic');
    });
  });

  describe('ListRunsArgs schema', () => {
    it('should have default values', () => {
      const args: ListRunsArgs = {
        status: 'all',
        limit: 20,
        json: false,
      };

      expect(args.status).toBe('all');
      expect(args.limit).toBe(20);
      expect(args.json).toBe(false);
    });

    it('should accept valid status values', () => {
      const runningArgs: ListRunsArgs = { status: 'running', limit: 10, json: false };
      const completedArgs: ListRunsArgs = { status: 'completed', limit: 10, json: false };
      const failedArgs: ListRunsArgs = { status: 'failed', limit: 10, json: false };

      expect(runningArgs.status).toBe('running');
      expect(completedArgs.status).toBe('completed');
      expect(failedArgs.status).toBe('failed');
    });
  });

  describe('RunSummary type', () => {
    it('should have correct structure', () => {
      const summary: RunSummary = {
        runId: 'test-id',
        status: 'published',
        topic: 'Topic',
        startedAt: '2024-01-15T10:00:00.000Z',
        durationMs: 5000,
        totalCostUsd: 0.1,
        moduleCount: 3,
      };

      expect(summary.runId).toBeDefined();
      expect(summary.status).toBeDefined();
      expect(summary.topic).toBeDefined();
    });
  });
});
