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
import { FatalError } from '@/core/errors.js';
import {
  migrateLegacyPipelineState,
  PipelineStateSchema,
  type PipelineState,
} from '@/core/state.js';
import { assertValid } from '@/lib/schemaValidator.js';

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

  public constructor(options?: StateStoreOptions) {
    this.storageDir = options?.storageDir ?? DEFAULT_STORAGE_DIR;
  }

  /** Initializes the storage directory if it doesn't exist. */
  public async initialize(): Promise<void> {
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
   * Saves a runtime-valid PipelineState snapshot.
   *
   * @param state - The state to save.
   * @param suffix - Optional suffix for the filename (e.g., 'completed', 'failed').
   */
  public async save(state: PipelineState, suffix?: string): Promise<void> {
    const validatedState = assertValid(PipelineStateSchema, state, 'state-store');

    await this.withLock(validatedState.metadata.runId, async () => {
      await this.ensureInitialized();
      const filename = this.getFilename(validatedState.metadata.runId, suffix);
      const content = JSON.stringify(validatedState, null, 2);

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
  public async load(runId: string, suffix?: string): Promise<PipelineState | null> {
    await this.ensureInitialized();

    // Try with suffix first, then without.
    const filenames = suffix
      ? [this.getFilename(runId, suffix), this.getFilename(runId)]
      : [this.getFilename(runId)];

    for (const filename of filenames) {
      try {
        const content = await readFile(filename, 'utf-8');
        return this.deserialize(content, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }

        if (error instanceof FatalError) {
          throw error;
        }

        throw new FatalError('state-store', `Failed to load state: ${errorMessage(error)}`);
      }
    }

    return null;
  }

  /**
   * Finds a resumable run (a run that was interrupted mid-pipeline).
   *
   * @returns The first running state in storage, or null.
   */
  public async findResumable(): Promise<PipelineState | null> {
    await this.ensureInitialized();

    try {
      const files = await readdir(this.storageDir);
      const runningFiles = files.filter(
        (file) =>
          file.endsWith('.json') && !file.includes('.completed.') && !file.includes('.failed.'),
      );

      for (const file of runningFiles) {
        const filename = join(this.storageDir, file);
        const content = await readFile(filename, 'utf-8');
        const state = this.deserialize(content, filename);

        if (state.metadata.status === 'running') {
          return state;
        }
      }

      return null;
    } catch (error) {
      if (error instanceof FatalError) {
        throw error;
      }

      throw new FatalError('state-store', `Failed to find resumable state: ${errorMessage(error)}`);
    }
  }

  /**
   * Lists all run IDs in storage.
   *
   * @param suffix - Optional suffix to filter by (e.g., 'completed', 'failed').
   * @returns Array of run IDs.
   */
  public async listRuns(suffix?: string): Promise<string[]> {
    await this.ensureInitialized();

    try {
      const files = await readdir(this.storageDir);
      const suffixPattern = suffix ? `.${suffix}.json` : '.json';

      return files
        .filter((file) => file.endsWith(suffixPattern))
        .map((file) =>
          suffix
            ? file.replace(suffixPattern, '')
            : file.replace(/\.(?:completed|failed)\.json$/, '').replace('.json', ''),
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
  public async delete(runId: string, suffix?: string): Promise<void> {
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
  public async exists(runId: string, suffix?: string): Promise<boolean> {
    await this.ensureInitialized();

    const filename = this.getFilename(runId, suffix);

    try {
      await access(filename);
      return true;
    } catch {
      return false;
    }
  }

  /** Parses, migrates, and validates persisted state before it is returned. */
  private deserialize(content: string, filename: string): PipelineState {
    try {
      const parsed: unknown = JSON.parse(content);
      return assertValid(PipelineStateSchema, migrateLegacyPipelineState(parsed), 'state-store');
    } catch (error) {
      throw new FatalError(
        'state-store',
        `Invalid state snapshot "${filename}": ${errorMessage(error)}`,
      );
    }
  }

  /** Gets the full path for a state file. */
  private getFilename(runId: string, suffix?: string): string {
    const base = `${runId}.json`;
    return suffix ? join(this.storageDir, `${runId}.${suffix}.json`) : join(this.storageDir, base);
  }

  /** Ensures the storage directory exists. */
  private async ensureInitialized(): Promise<void> {
    try {
      await access(this.storageDir);
    } catch {
      await this.initialize();
    }
  }

  /** Executes an operation with a lock to prevent concurrent writes. */
  private async withLock(runId: string, operation: () => Promise<void>): Promise<void> {
    const existingLock = this.locks.get(runId);
    if (existingLock) {
      await existingLock;
    }

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

/** Gets the default StateStore instance. */
export function getStateStore(options?: StateStoreOptions): StateStore {
  if (!defaultInstance) {
    defaultInstance = new StateStore(options);
  }
  return defaultInstance;
}

/** Resets the default StateStore instance (for testing). */
export function resetStateStore(): void {
  defaultInstance = null;
}
