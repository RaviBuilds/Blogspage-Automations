/**
 * State persistence for PipelineState snapshots.
 *
 * The stateStore persists PipelineState after every module completes, enabling:
 * - Crash recovery and resume from the last successful step
 * - Debugging of failed runs
 * - Audit trail of state evolution
 *
 * @see architecture/02-folder-structure.md - storage/state/ location
 * @see architecture/12-future-roadmap.md - Phase 7 (Orchestrator) will integrate this
 */

import { mkdir, readFile, writeFile, access, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineState } from '@/core/state.js';
import { FatalError } from '@/core/errors.js';

/** Default storage directory for state snapshots. */
const DEFAULT_STORAGE_DIR = 'storage/state';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Options for the state store. */
export interface StateStoreOptions {
  /** Base directory for state storage (default: 'storage/state'). */
  readonly storageDir?: string;
}

/**
 * Persistent storage for PipelineState snapshots.
 *
 * Each run is stored as a separate JSON file named by runId:
 * - Active runs: `{runId}.json`
 * - Completed runs: `{runId}.completed.json`
 * - Failed runs: `{runId}.failed.json`
 */
export class StateStore {
  private readonly storageDir: string;
  private readonly locks: Map<string, Promise<void>> = new Map();

  constructor(options?: StateStoreOptions) {
    this.storageDir = options?.storageDir ?? DEFAULT_STORAGE_DIR;
  }

  /**
   * Initializes the storage directory if it doesn't exist.
   */
  async initialize(): Promise<void> {
    try {
      await mkdir(this.storageDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FatalError(
          'state-store',
          `Failed to create storage directory: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Saves a PipelineState snapshot.
   *
   * @param state - The state to save.
   * @param suffix - Optional suffix for the filename (e.g., 'completed', 'failed').
   */
  async save(state: PipelineState, suffix?: string): Promise<void> {
    await this.withLock(state.metadata.runId, async () => {
      await this.ensureInitialized();
      const filename = this.getFilename(state.metadata.runId, suffix);
      const content = JSON.stringify(state, null, 2);

      try {
        await writeFile(filename, content, 'utf-8');
      } catch (error) {
        throw new FatalError('state-store', `Failed to save state: ${errorMessage(error)}`);
      }
    });
  }

  /**
   * Loads a PipelineState snapshot by runId.
   *
   * @param runId - The run ID to load.
   * @param suffix - Optional suffix to try (e.g., 'completed', 'failed').
   * @returns The loaded state, or null if not found.
   */
  async load(runId: string, suffix?: string): Promise<PipelineState | null> {
    await this.ensureInitialized();

    // Try with suffix first, then without
    const filenames = suffix
      ? [this.getFilename(runId, suffix), this.getFilename(runId)]
      : [this.getFilename(runId)];

    for (const filename of filenames) {
      try {
        const content = await readFile(filename, 'utf-8');
        return JSON.parse(content) as PipelineState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new FatalError('state-store', `Failed to load state: ${errorMessage(error)}`);
        }
      }
    }

    return null;
  }

  /**
   * Finds a resumable run (a run that was interrupted mid-pipeline).
   *
   * @returns The most recent running state that can be resumed, or null.
   */
  async findResumable(): Promise<PipelineState | null> {
    await this.ensureInitialized();

    try {
      const files = await readdir(this.storageDir);
      const runningFiles = files
        .filter((f) => f.endsWith('.json') && !f.includes('.completed.') && !f.includes('.failed.'))
        .map((f) => join(this.storageDir, f));

      if (runningFiles.length === 0) {
        return null;
      }

      // Load each file and check if it's in 'running' status
      for (const file of runningFiles) {
        try {
          const content = await readFile(file, 'utf-8');
          const state = JSON.parse(content) as PipelineState;

          if (state.metadata.status === 'running') {
            return state;
          }
        } catch {
          // Skip invalid files
          continue;
        }
      }

      return null;
    } catch (error) {
      throw new FatalError('state-store', `Failed to find resumable state: ${errorMessage(error)}`);
    }
  }

  /**
   * Lists all run IDs in storage.
   *
   * @param suffix - Optional suffix to filter by (e.g., 'completed', 'failed').
   * @returns Array of run IDs.
   */
  async listRuns(suffix?: string): Promise<string[]> {
    await this.ensureInitialized();

    try {
      const files = await readdir(this.storageDir);
      const suffixPattern = suffix ? `.${suffix}.json` : '.json';

      return files
        .filter((f) => f.endsWith(suffixPattern))
        .map((f) =>
          suffix
            ? f.replace(suffixPattern, '')
            : f.replace(/\.(?:completed|failed)\.json$/, '').replace('.json', ''),
        );
    } catch (error) {
      throw new FatalError('state-store', `Failed to list runs: ${errorMessage(error)}`);
    }
  }

  /**
   * Deletes a state file by runId.
   *
   * @param runId - The run ID to delete.
   * @param suffix - Optional suffix (e.g., 'completed', 'failed').
   */
  async delete(runId: string, suffix?: string): Promise<void> {
    await this.ensureInitialized();

    const filename = this.getFilename(runId, suffix);

    try {
      await unlink(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new FatalError('state-store', `Failed to delete state: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Checks if a state file exists.
   *
   * @param runId - The run ID to check.
   * @param suffix - Optional suffix (e.g., 'completed', 'failed').
   * @returns True if the state file exists.
   */
  async exists(runId: string, suffix?: string): Promise<boolean> {
    await this.ensureInitialized();

    const filename = this.getFilename(runId, suffix);

    try {
      await access(filename);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets the full path for a state file.
   */
  private getFilename(runId: string, suffix?: string): string {
    const base = `${runId}.json`;
    return suffix ? join(this.storageDir, `${runId}.${suffix}.json`) : join(this.storageDir, base);
  }

  /**
   * Ensures the storage directory exists.
   */
  private async ensureInitialized(): Promise<void> {
    try {
      await access(this.storageDir);
    } catch {
      await this.initialize();
    }
  }

  /**
   * Executes an operation with a lock to prevent concurrent writes.
   */
  private async withLock(runId: string, operation: () => Promise<void>): Promise<void> {
    // Wait for any existing lock on this runId
    const existingLock = this.locks.get(runId);
    if (existingLock) {
      await existingLock;
    }

    // Create a new lock
    const lockPromise = operation();
    this.locks.set(runId, lockPromise);

    try {
      await lockPromise;
    } finally {
      this.locks.delete(runId);
    }
  }
}

/** Singleton instance for convenience. */
let defaultInstance: StateStore | null = null;

/**
 * Gets the default state store instance.
 *
 * @param options - Optional configuration.
 * @returns The default StateStore instance.
 */
export function getStateStore(options?: StateStoreOptions): StateStore {
  if (!defaultInstance) {
    defaultInstance = new StateStore(options);
  }
  return defaultInstance;
}

/**
 * Resets the default state store instance (for testing).
 */
export function resetStateStore(): void {
  defaultInstance = null;
}
