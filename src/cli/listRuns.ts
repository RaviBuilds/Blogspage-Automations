/**
 * Pipeline CLI - List Runs Command
 *
 * Lists all stored pipeline runs with their status and metadata.
 *
 * Usage:
 *   node --import=tsx src/cli/listRuns.ts
 *   node --import=tsx src/cli/listRuns.ts --status running
 *   node --import=tsx src/cli/listRuns.ts --status completed
 *   node --import=tsx src/cli/listRuns.ts --status failed
 *   node --import=tsx src/cli/listRuns.ts --limit 20
 */

import { config } from 'dotenv';
import { z } from 'zod';

import { FatalError } from '@/core/errors.js';
import { type PipelineState } from '@/core/state.js';
import { StateStore } from '@/core/stateStore.js';

// ============================================================================
// CLI Argument Schema
// ============================================================================

const ListRunsArgsSchema = z.object({
  status: z.enum(['running', 'completed', 'failed', 'all']).optional().default('all'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  json: z.coerce.boolean().optional().default(false),
});

type ListRunsArgs = z.infer<typeof ListRunsArgsSchema>;

// ============================================================================
// Run Summary
// ============================================================================

interface RunSummary {
  readonly runId: string;
  readonly status: string;
  readonly topic: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly totalCostUsd: number;
  readonly moduleCount: number;
  readonly error?: string | undefined;
}

// ============================================================================
// List Execution
// ============================================================================

async function listRuns(args: ListRunsArgs): Promise<RunSummary[]> {
  const stateStore = new StateStore();
  await stateStore.initialize();

  // Determine which suffix to use
  const suffixMap: Record<string, 'completed' | 'failed' | undefined> = {
    running: undefined,
    completed: 'completed',
    failed: 'failed',
    all: undefined,
  };

  const suffix = suffixMap[args.status];

  // Get run IDs
  let runIds: string[];

  if (args.status === 'all') {
    // Get all runs from all statuses
    const running = await stateStore.listRuns();
    const completed = await stateStore.listRuns('completed');
    const failed = await stateStore.listRuns('failed');

    // Deduplicate (a run can have multiple files)
    runIds = [...new Set([...running, ...completed, ...failed])];
  } else {
    runIds = await stateStore.listRuns(suffix);
  }

  // Load each run and create summary
  const summaries: RunSummary[] = [];

  for (const runId of runIds.slice(0, args.limit)) {
    const state = await loadRunState(stateStore, runId);

    if (state === null) continue;

    // Filter by status if needed
    if (args.status !== 'all' && state.metadata.status !== args.status) {
      continue;
    }

    summaries.push(createRunSummary(state));
  }

  // Sort by startedAt (newest first)
  summaries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return summaries;
}

async function loadRunState(stateStore: StateStore, runId: string): Promise<PipelineState | null> {
  // Try loading in order: base, completed, failed
  const state = await stateStore.load(runId);
  if (state) return state;

  const completedState = await stateStore.load(runId, 'completed');
  if (completedState) return completedState;

  const failedState = await stateStore.load(runId, 'failed');
  return failedState;
}

function createRunSummary(state: PipelineState): RunSummary {
  const durationMs = state.timings.reduce((sum, t) => sum + t.durationMs, 0);
  const lastError = state.errors.find(e => !e.resolved);

  return {
    runId: state.metadata.runId,
    status: state.metadata.status,
    topic: state.brief?.topic ?? 'No topic',
    startedAt: state.metadata.startedAt,
    durationMs,
    totalCostUsd: state.metrics.totalCostUsd,
    moduleCount: state.timings.length,
    error: lastError?.message,
  };
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatDuration(ms: number): string {
  if (ms === 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '-';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `Today ${date.toTimeString().slice(0, 5)}`;
  } else if (diffDays === 1) {
    return `Yesterday ${date.toTimeString().slice(0, 5)}`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toISOString().slice(0, 10);
  }
}

function printTable(summaries: RunSummary[]): void {
  if (summaries.length === 0) {
    console.log('No runs found.');
    return;
  }

  console.log('\n' + '='.repeat(100));
  console.log('Pipeline Runs');
  console.log('='.repeat(100));

  // Header
  const header = [
    'Run ID'.padEnd(36),
    'Status'.padEnd(10),
    'Topic'.padEnd(30),
    'Started'.padEnd(14),
    'Duration'.padEnd(10),
    'Cost'.padEnd(8),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(100));

  // Rows
  for (const summary of summaries) {
    const statusIcon = summary.status === 'published' ? '✓' : summary.status === 'failed' ? '✗' : '○';
    const statusDisplay = `${statusIcon} ${summary.status}`.padEnd(10);

    const row = [
      summary.runId.slice(0, 36).padEnd(36),
      statusDisplay,
      summary.topic.slice(0, 28).padEnd(30),
      formatDate(summary.startedAt).padEnd(14),
      formatDuration(summary.durationMs).padEnd(10),
      formatCost(summary.totalCostUsd).padEnd(8),
    ].join(' ');

    console.log(row);

    if (summary.error) {
      console.log(`  Error: ${summary.error.slice(0, 90)}`);
    }
  }

  console.log('='.repeat(100));
  console.log(`Total: ${summaries.length} run(s)`);
}

function printJson(summaries: RunSummary[]): void {
  console.log(JSON.stringify(summaries, null, 2));
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function parseArgs(): ListRunsArgs {
  const args: Record<string, string> = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (typeof arg === 'string' && arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = process.argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      } else if (key === 'json') {
        args.json = 'true';
      }
    }
  }

  return ListRunsArgsSchema.parse(args);
}

async function main(): Promise<void> {
  config();

  try {
    const args = parseArgs();
    const summaries = await listRuns(args);

    if (args.json) {
      printJson(summaries);
    } else {
      printTable(summaries);
    }

    process.exit(0);
  } catch (error: unknown) {
    console.error('\n✗ Failed to list runs:');
    if (error instanceof FatalError) {
      console.error(`  ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`  ${error.message}`);
    } else {
      console.error(`  ${String(error)}`);
    }
    process.exit(1);
  }
}

// Run only when executed directly (skipped when imported by tests).
// import.meta.main is a Node ≥ 21.2 runtime value; @types/node hasn't typed it yet.
if ((import.meta as { main?: boolean }).main) {
  main();
}

export {
  listRuns,
  createRunSummary,
  type ListRunsArgs,
  type RunSummary,
};
