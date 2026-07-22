/**
 * Tests for StateStore - PipelineState persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { StateStore, getStateStore, resetStateStore } from '../stateStore.js';
import { createInitialState, type PipelineState } from '../state.js';

const TEST_STORAGE_DIR = 'storage/test-state';

describe('StateStore', () => {
  let store: StateStore;

  beforeEach(async () => {
    // Clean up test directory
    try {
      await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    store = new StateStore({ storageDir: TEST_STORAGE_DIR });
    await store.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
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
    it('saves and loads a PipelineState', async () => {
      const state = createInitialState({ sheetRowId: 'test-row-1' });

      await store.save(state);

      const loaded = await store.load(state.metadata.runId);

      expect(loaded).not.toBeNull();
      expect(loaded?.metadata.runId).toBe(state.metadata.runId);
      expect(loaded?.metadata.sheetRowId).toBe('test-row-1');
      expect(loaded?.metadata.status).toBe('running');
    });

    it('saves with a suffix', async () => {
      const state = createInitialState();

      await store.save(state, 'completed');

      const loaded = await store.load(state.metadata.runId, 'completed');

      expect(loaded).not.toBeNull();
      expect(loaded?.metadata.runId).toBe(state.metadata.runId);
    });

    it('returns null if state does not exist', async () => {
      const loaded = await store.load('non-existent-run-id');

      expect(loaded).toBeNull();
    });

    it('preserves all state data', async () => {
      const state: PipelineState = {
        ...createInitialState(),
        brief: {
          topic: 'Test Topic',
          targetAudience: 'Developers',
          keywordHints: ['keyword1', 'keyword2'],
          constraints: ['constraint1'],
          sheetRowId: 'row-123',
        },
        metrics: {
          costEvents: [
            {
              runId: 'test',
              module: 'research',
              provider: 'anthropic',
              model: 'claude-3-5-haiku',
              inputTokens: 100,
              outputTokens: 200,
              costUsd: 0.001,
              cached: false,
              timestamp: '2026-01-01T00:00:00Z',
            },
          ],
          totalCostUsd: 0.001,
        },
      };

      await store.save(state);

      const loaded = await store.load(state.metadata.runId);

      expect(loaded?.brief?.topic).toBe('Test Topic');
      expect(loaded?.brief?.keywordHints).toEqual(['keyword1', 'keyword2']);
      expect(loaded?.metrics.costEvents).toHaveLength(1);
      expect(loaded?.metrics.totalCostUsd).toBe(0.001);
    });
  });

  describe('exists', () => {
    it('returns true if state exists', async () => {
      const state = createInitialState();
      await store.save(state);

      const exists = await store.exists(state.metadata.runId);

      expect(exists).toBe(true);
    });

    it('returns false if state does not exist', async () => {
      const exists = await store.exists('non-existent-run-id');

      expect(exists).toBe(false);
    });

    it('checks for suffixed files', async () => {
      const state = createInitialState();
      await store.save(state, 'completed');

      const exists = await store.exists(state.metadata.runId, 'completed');

      expect(exists).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes a state file', async () => {
      const state = createInitialState();
      await store.save(state);

      await store.delete(state.metadata.runId);

      const exists = await store.exists(state.metadata.runId);
      expect(exists).toBe(false);
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

      const completedRuns = await store.listRuns('completed');

      expect(completedRuns).toHaveLength(1);
      expect(completedRuns).toContain(state2.metadata.runId);
    });
  });

  describe('findResumable', () => {
    it('finds a running state that can be resumed', async () => {
      const runningState = createInitialState();
      const completedState: PipelineState = {
        ...createInitialState(),
        metadata: {
          ...createInitialState().metadata,
          status: 'published',
        },
      };

      await store.save(runningState);
      await store.save(completedState, 'completed');

      const resumable = await store.findResumable();

      expect(resumable).not.toBeNull();
      expect(resumable?.metadata.runId).toBe(runningState.metadata.runId);
      expect(resumable?.metadata.status).toBe('running');
    });

    it('returns null if no running state exists', async () => {
      const completedState: PipelineState = {
        ...createInitialState(),
        metadata: {
          ...createInitialState().metadata,
          status: 'published',
        },
      };

      await store.save(completedState, 'completed');

      const resumable = await store.findResumable();

      expect(resumable).toBeNull();
    });
  });

  describe('concurrent access', () => {
    it('handles concurrent saves to the same runId', async () => {
      const state = createInitialState();

      // Save twice concurrently
      await Promise.all([
        store.save({ ...state, metrics: { costEvents: [], totalCostUsd: 0.01 } }),
        store.save({ ...state, metrics: { costEvents: [], totalCostUsd: 0.02 } }),
      ]);

      // Should complete without error
      const exists = await store.exists(state.metadata.runId);
      expect(exists).toBe(true);
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

  it('creates new instance after reset', () => {
    const store1 = getStateStore();
    resetStateStore();
    const store2 = getStateStore();

    expect(store1).not.toBe(store2);
  });
});
