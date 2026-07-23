/**
 * Tests for StateStore PipelineState persistence boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FatalError, ValidationError } from '../errors.js';
import { createInitialState, type CostEvent, type PipelineState } from '../state.js';
import { StateStore, getStateStore, resetStateStore } from '../stateStore.js';

const TEST_STORAGE_DIR = 'storage/test-state';
const TIMESTAMP = '2026-07-22T12:00:00.000Z';

function createCostEvent(runId: string): CostEvent {
  return {
    runId,
    moduleKey: 'research',
    attemptNumber: 1,
    timestamp: TIMESTAMP,
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    promptVersion: 'abc1234',
    inputTokens: 100,
    outputTokens: 200,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0.001,
    pricingVerifiedAt: '2026-07-01',
    latencyMs: 250,
    outcome: 'success',
    isImageGeneration: false,
  };
}

function createPopulatedState(): PipelineState {
  const initial = createInitialState({ sheetRowId: 'row-123' });
  const costEvent = createCostEvent(initial.metadata.runId);

  return {
    ...initial,
    brief: {
      topic: 'Test Topic',
      targetAudience: 'Developers',
      keywordHints: ['keyword1', 'keyword2'],
      constraints: ['constraint1'],
      sheetRowId: 'row-123',
    },
    metrics: {
      costEvents: [costEvent],
      totalCostUsd: costEvent.estimatedCostUsd,
    },
  };
}

describe('StateStore', () => {
  let store: StateStore;

  beforeEach(async () => {
    await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    store = new StateStore({ storageDir: TEST_STORAGE_DIR });
    await store.initialize();
  });

  afterEach(async () => {
    await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates the storage directory if it does not exist', async () => {
      const newDir = join(TEST_STORAGE_DIR, 'new-dir');
      const newStore = new StateStore({ storageDir: newDir });

      await newStore.initialize();

      await expect(access(newDir)).resolves.toBeUndefined();
    });

    it('does not throw if directory already exists', async () => {
      await expect(store.initialize()).resolves.toBeUndefined();
    });
  });

  describe('save and load', () => {
    it('saves and loads a runtime-valid PipelineState', async () => {
      const state = createInitialState({ sheetRowId: 'test-row-1' });

      await store.save(state);

      const loaded = await store.load(state.metadata.runId);

      expect(loaded).toEqual(state);
    });

    it('round-trips populated state with final CostEvent fields', async () => {
      const state = createPopulatedState();

      await store.save(state);

      await expect(store.load(state.metadata.runId)).resolves.toEqual(state);
    });

    it('saves with a suffix', async () => {
      const state = createInitialState();

      await store.save(state, 'completed');

      await expect(store.load(state.metadata.runId, 'completed')).resolves.toEqual(state);
    });

    it('returns null if state does not exist', async () => {
      await expect(store.load('non-existent-run-id')).resolves.toBeNull();
    });

    it('migrates the documented legacy flat state when loading', async () => {
      const state = createPopulatedState();
      const legacy = {
        ...state,
        contentPlan: {
          titleCandidates: ['Legacy title'],
          outline: [],
          targetWordCount: 1000,
          angle: 'Legacy angle',
        },
        technicalReview: {
          passed: true,
          issues: [],
        },
        reviewLoop: {
          iteration: 1,
        },
        imagePlan: {
          images: [],
        },
      };
      delete (legacy as Record<string, unknown>).planning;

      await writeFile(
        join(TEST_STORAGE_DIR, `${state.metadata.runId}.json`),
        JSON.stringify(legacy),
        'utf-8',
      );

      const loaded = await store.load(state.metadata.runId);

      expect(loaded?.planning?.angle).toBe('Legacy angle');
      expect(loaded?.review?.technical?.passed).toBe(true);
      expect(loaded?.images?.plan?.images).toEqual([]);
      expect(loaded).not.toHaveProperty('contentPlan');
      expect(loaded).not.toHaveProperty('technicalReview');
      expect(loaded).not.toHaveProperty('imagePlan');
    });

    it('fails closed when save receives an invalid unsafe cast', async () => {
      const invalid = {
        ...createInitialState(),
        metrics: {
          costEvents: [],
          totalCostUsd: 'not-a-number',
        },
      } as unknown as PipelineState;

      await expect(store.save(invalid)).rejects.toBeInstanceOf(ValidationError);
    });

    it('fails closed for malformed JSON snapshots', async () => {
      const runId = 'malformed-state';
      await writeFile(join(TEST_STORAGE_DIR, `${runId}.json`), '{not JSON', 'utf-8');

      await expect(store.load(runId)).rejects.toBeInstanceOf(FatalError);
    });

    it('fails closed for schema-invalid snapshots', async () => {
      const runId = 'invalid-state';
      await writeFile(
        join(TEST_STORAGE_DIR, `${runId}.json`),
        JSON.stringify({ metadata: {} }),
        'utf-8',
      );

      await expect(store.load(runId)).rejects.toBeInstanceOf(FatalError);
    });

    it('fails closed for ambiguous legacy snapshots', async () => {
      const state = createInitialState();
      const ambiguous = {
        ...state,
        planning: {
          titleCandidates: [],
          outline: [],
          targetWordCount: 1000,
          angle: 'Nested',
        },
        contentPlan: {
          titleCandidates: [],
          outline: [],
          targetWordCount: 1000,
          angle: 'Legacy',
        },
      };
      await writeFile(
        join(TEST_STORAGE_DIR, `${state.metadata.runId}.json`),
        JSON.stringify(ambiguous),
        'utf-8',
      );

      await expect(store.load(state.metadata.runId)).rejects.toBeInstanceOf(FatalError);
    });
  });

  describe('exists', () => {
    it('returns true if state exists', async () => {
      const state = createInitialState();
      await store.save(state);

      await expect(store.exists(state.metadata.runId)).resolves.toBe(true);
    });

    it('returns false if state does not exist', async () => {
      await expect(store.exists('non-existent-run-id')).resolves.toBe(false);
    });

    it('checks for suffixed files', async () => {
      const state = createInitialState();
      await store.save(state, 'completed');

      await expect(store.exists(state.metadata.runId, 'completed')).resolves.toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes a state file', async () => {
      const state = createInitialState();
      await store.save(state);

      await store.delete(state.metadata.runId);

      await expect(store.exists(state.metadata.runId)).resolves.toBe(false);
    });

    it('does not throw if file does not exist', async () => {
      await expect(store.delete('non-existent-run-id')).resolves.toBeUndefined();
    });
  });

  describe('listRuns', () => {
    it('lists all run IDs', async () => {
      const state1 = createInitialState();
      const state2 = createInitialState();
      await store.save(state1);
      await store.save(state2, 'completed');

      const runs = await store.listRuns();

      expect(runs).toHaveLength(2);
      expect(runs).toContain(state1.metadata.runId);
      expect(runs).toContain(state2.metadata.runId);
    });

    it('filters by suffix', async () => {
      const state1 = createInitialState();
      const state2 = createInitialState();
      await store.save(state1);
      await store.save(state2, 'completed');

      await expect(store.listRuns('completed')).resolves.toEqual([state2.metadata.runId]);
    });
  });

  describe('findResumable', () => {
    it('finds a running state that can be resumed', async () => {
      const runningState = createInitialState();
      const completedBase = createInitialState();
      const completedState: PipelineState = {
        ...completedBase,
        metadata: {
          ...completedBase.metadata,
          status: 'published',
        },
      };

      await store.save(runningState);
      await store.save(completedState, 'completed');

      await expect(store.findResumable()).resolves.toEqual(runningState);
    });

    it('returns null if no running state exists', async () => {
      const completedBase = createInitialState();
      const completedState: PipelineState = {
        ...completedBase,
        metadata: {
          ...completedBase.metadata,
          status: 'published',
        },
      };

      await store.save(completedState, 'completed');

      await expect(store.findResumable()).resolves.toBeNull();
    });

    it('fails closed for invalid active snapshots', async () => {
      await writeFile(join(TEST_STORAGE_DIR, 'invalid-running.json'), '{bad JSON', 'utf-8');

      await expect(store.findResumable()).rejects.toBeInstanceOf(FatalError);
    });
  });

  describe('concurrent access', () => {
    it('handles concurrent saves to the same runId', async () => {
      const state = createInitialState();

      await Promise.all([
        store.save({ ...state, metrics: { costEvents: [], totalCostUsd: 0.01 } }),
        store.save({ ...state, metrics: { costEvents: [], totalCostUsd: 0.02 } }),
      ]);

      await expect(store.exists(state.metadata.runId)).resolves.toBe(true);
    });
  });
});

describe('getStateStore', () => {
  beforeEach(() => {
    resetStateStore();
  });

  it('returns a singleton instance', () => {
    const store1 = getStateStore();
    const store2 = getStateStore();

    expect(store1).toBe(store2);
  });

  it('creates a new instance after reset', () => {
    const store1 = getStateStore();
    resetStateStore();
    const store2 = getStateStore();

    expect(store1).not.toBe(store2);
  });
});
