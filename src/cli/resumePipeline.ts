/**
 * Pipeline CLI - Resume Command
 *
 * Resumes an interrupted pipeline run from its last successful checkpoint.
 *
 * Usage:
 *   node --import=tsx src/cli/resumePipeline.ts <runId>
 *   node --import=tsx src/cli/resumePipeline.ts --run-id <runId>
 */

import { config } from 'dotenv';
import { z } from 'zod';

import { loadConfig } from '@/config/env.js';
import { FatalError } from '@/core/errors.js';
import { createModuleRegistry, type ModuleRegistry, ModuleRunner } from '@/core/moduleRunner.js';
import { PipelineOrchestrator, type OrchestrationResult, type OrchestratorModuleBinding } from '@/core/orchestrator.js';
import { type PipelineState } from '@/core/state.js';
import { StateStore } from '@/core/stateStore.js';
import type { ModelTier } from '@/core/types.js';
import { createPromptRegistry, type DevelopmentPromptRegistry } from '@/prompts/registry.js';
import { getProvider, type LLMProvider } from '@/providers/llm/providerFactory.js';

// Import all production modules and their bindings
import { createResearchModule, createResearchModuleBinding } from '@/modules/research/researchModule.js';
import { createPlannerModule, createPlannerModuleBinding } from '@/modules/planner/plannerModule.js';
import { createSEOOptimizerModule, createSEOOptimizerModuleBinding } from '@/modules/seo-planner/seoOptimizerModule.js';
import { createDraftWriterModule, createDraftWriterModuleBinding } from '@/modules/writer/draftWriterModule.js';
import { createReviewerModule, createReviewerModuleBinding } from '@/modules/reviewer-technical/reviewerModule.js';
import { createHumanizerModule, createHumanizerModuleBinding } from '@/modules/humanizer/humanizerModule.js';
import { createContentAssetsPlannerModule, createContentAssetsPlannerModuleBinding } from '@/modules/content-assets-planner/contentAssetsPlannerModule.js';
import { createPublisherModule, createPublisherModuleBinding } from '@/modules/publisher/publisherModule.js';

// ============================================================================
// CLI Argument Schema
// ============================================================================

const ResumeArgsSchema = z.object({
  runId: z.string().trim().min(1),
});

type ResumeArgs = z.infer<typeof ResumeArgsSchema>;

// ============================================================================
// Pipeline Services
// ============================================================================

interface PipelineServices {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: DevelopmentPromptRegistry;
}

// ============================================================================
// Output Formatting
// ============================================================================

interface ResumeSummary {
  readonly runId: string;
  readonly status: 'success' | 'failed' | 'not_found';
  readonly topic: string;
  readonly resumedFrom: readonly string[];
  readonly completedModules: readonly string[];
  readonly pendingModules: readonly string[];
  readonly totalDurationMs: number;
  readonly totalCostUsd: number;
  readonly error?: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ============================================================================
// Module Registration
// ============================================================================

function registerAllModules(registry: ModuleRegistry<PipelineServices>): void {
  registry
    .register(createResearchModule())
    .register(createPlannerModule())
    .register(createSEOOptimizerModule())
    .register(createDraftWriterModule())
    .register(createReviewerModule())
    .register(createHumanizerModule())
    .register(createContentAssetsPlannerModule())
    .register(createPublisherModule());
}

function createAllModuleBindings(): readonly OrchestratorModuleBinding<PipelineServices>[] {
  return [
    createResearchModuleBinding(),
    createPlannerModuleBinding(),
    createSEOOptimizerModuleBinding(),
    createDraftWriterModuleBinding(),
    createReviewerModuleBinding(),
    createHumanizerModuleBinding(),
    createContentAssetsPlannerModuleBinding(),
    createPublisherModuleBinding(),
  ];
}

// ============================================================================
// Pipeline Initialization
// ============================================================================

interface PipelineContext {
  readonly config: ReturnType<typeof loadConfig>;
  readonly stateStore: StateStore;
  readonly promptRegistry: DevelopmentPromptRegistry;
  readonly registry: ModuleRegistry<PipelineServices>;
  readonly runner: ModuleRunner<PipelineServices>;
  readonly orchestrator: PipelineOrchestrator<PipelineServices>;
}

async function initializePipeline(tier: ModelTier = 'STANDARD'): Promise<PipelineContext> {
  const appConfig = loadConfig();
  const promptRegistry = createPromptRegistry();
  const stateStore = new StateStore();
  await stateStore.initialize();

  const llmProvider = getProvider(tier, appConfig);

  const services: PipelineServices = {
    llmProvider,
    promptRegistry,
  };

  const registry = createModuleRegistry<PipelineServices>();
  registerAllModules(registry);

  const runner = new ModuleRunner({ registry });
  const bindings = createAllModuleBindings();

  const orchestrator = new PipelineOrchestrator({
    registry,
    runner,
    stateStore,
    services,
    bindings,
  });

  return {
    config: appConfig,
    stateStore,
    promptRegistry,
    registry,
    runner,
    orchestrator,
  };
}

// ============================================================================
// Resume Execution
// ============================================================================

async function resumePipeline(args: ResumeArgs): Promise<ResumeSummary> {
  const startedAt = Date.now();

  // Initialize pipeline
  const context = await initializePipeline();

  // Load the state
  const state = await context.stateStore.load(args.runId);

  if (state === null) {
    console.error(`\n✗ Run not found: ${args.runId}`);
    return {
      runId: args.runId,
      status: 'not_found',
      topic: 'Unknown',
      resumedFrom: [],
      completedModules: [],
      pendingModules: [],
      totalDurationMs: 0,
      totalCostUsd: 0,
      error: 'Run not found',
    };
  }

  // Check if already completed
  if (state.metadata.status !== 'running') {
    console.log(`\nRun ${args.runId} is already in status: ${state.metadata.status}`);
    return {
      runId: args.runId,
      status: state.metadata.status === 'published' ? 'success' : 'failed',
      topic: state.brief?.topic ?? 'Unknown',
      resumedFrom: [],
      completedModules: state.timings.map(t => t.module),
      pendingModules: [],
      totalDurationMs: state.timings.reduce((sum, t) => sum + t.durationMs, 0),
      totalCostUsd: state.metrics.totalCostUsd,
      error: state.metadata.status === 'failed' ? 'Run previously failed' : undefined,
    };
  }

  const topic = state.brief?.topic ?? 'Unknown';

  // Determine resume point
  const resumePoint = context.orchestrator.prepareResumePoint(state);

  console.log('\n' + '='.repeat(60));
  console.log('Resuming Pipeline');
  console.log('='.repeat(60));
  console.log(`Run ID:        ${args.runId}`);
  console.log(`Topic:         ${topic}`);
  console.log(`Completed:     ${resumePoint.completed.join(', ') || 'none'}`);
  console.log(`Pending:       ${resumePoint.pending.join(', ') || 'none'}`);
  console.log('='.repeat(60) + '\n');

  // Execute remaining modules
  const result: OrchestrationResult = await context.orchestrator.execute(state);

  const totalDurationMs = Date.now() - startedAt;
  const totalCostUsd = result.state.metrics.totalCostUsd;

  if (result.ok) {
    console.log('\n✓ Pipeline completed successfully\n');

    const summary: ResumeSummary = {
      runId: args.runId,
      status: 'success',
      topic,
      resumedFrom: resumePoint.completed,
      completedModules: result.state.timings.map(t => t.module),
      pendingModules: [],
      totalDurationMs,
      totalCostUsd,
    };

    printResumeSummary(summary);
    return summary;
  } else {
    const errorMessage = result.kind === 'module-failure'
      ? `${result.module}: ${result.error.message}`
      : result.error.message;

    console.log('\n✗ Pipeline failed\n');

    const summary: ResumeSummary = {
      runId: args.runId,
      status: 'failed',
      topic,
      resumedFrom: resumePoint.completed,
      completedModules: result.executions.map(e => e.module),
      pendingModules: resumePoint.pending.slice(result.executions.length),
      totalDurationMs,
      totalCostUsd,
      error: errorMessage,
    };

    printResumeSummary(summary);
    return summary;
  }
}

function printResumeSummary(summary: ResumeSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('Resume Summary');
  console.log('='.repeat(60));
  console.log(`Run ID:        ${summary.runId}`);
  console.log(`Status:        ${summary.status === 'success' ? '✓ Success' : summary.status === 'failed' ? '✗ Failed' : '? Not Found'}`);
  console.log(`Topic:         ${summary.topic}`);
  console.log(`Duration:      ${formatDuration(summary.totalDurationMs)}`);
  console.log(`Total Cost:    ${formatCost(summary.totalCostUsd)}`);

  if (summary.resumedFrom.length > 0) {
    console.log(`\nResumed From:`);
    for (const module of summary.resumedFrom) {
      console.log(`  ✓ ${module}`);
    }
  }

  if (summary.completedModules.length > 0) {
    console.log(`\nCompleted Modules:`);
    for (const module of summary.completedModules) {
      console.log(`  ✓ ${module}`);
    }
  }

  if (summary.pendingModules.length > 0) {
    console.log(`\nPending Modules:`);
    for (const module of summary.pendingModules) {
      console.log(`  ○ ${module}`);
    }
  }

  if (summary.error) {
    console.log(`\nError: ${summary.error}`);
  }

  console.log('='.repeat(60));
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function parseArgs(): ResumeArgs {
  const args: Record<string, string> = {};
  let positional: string | undefined;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = process.argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      }
    } else if (!positional) {
      positional = arg;
    }
  }

  // Support both positional and --run-id
  if (positional && !args.runId) {
    args.runId = positional;
  }

  return ResumeArgsSchema.parse(args);
}

async function main(): Promise<void> {
  config();

  try {
    const args = parseArgs();
    const summary = await resumePipeline(args);
    process.exit(summary.status === 'success' ? 0 : 1);
  } catch (error: unknown) {
    console.error('\n✗ Resume failed:');
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

main();

export {
  resumePipeline,
  type ResumeArgs,
  type ResumeSummary,
};
