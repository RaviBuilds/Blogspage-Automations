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
import { applyClientProfile, DEFAULT_PROFILE_ID, resolveClientProfile } from '@/config/profiles.js';
import { FatalError } from '@/core/errors.js';
import { createModuleRegistry, type ModuleRegistry, ModuleRunner } from '@/core/moduleRunner.js';
import { createPausePolicy } from '@/cli/pausePolicy.js';
import {
  PipelineOrchestrator,
  type OrchestrationResult,
  type OrchestratorModuleBinding,
} from '@/core/orchestrator.js';
import { StateStore } from '@/core/stateStore.js';
import type { ModelTier } from '@/core/types.js';
import {
  createPromptRegistry,
  type DevelopmentPromptRegistry,
  type PromptRegistry,
} from '@/prompts/registry.js';
import { getProvider, type LLMProvider } from '@/providers/llm/providerFactory.js';

// Import all production modules and their bindings
import {
  createResearchModule,
  createResearchModuleBinding,
} from '@/modules/research/researchModule.js';
import {
  createPlannerModule,
  createPlannerModuleBinding,
} from '@/modules/planner/plannerModule.js';
import {
  createSEOOptimizerModule,
  createSEOOptimizerModuleBinding,
} from '@/modules/seo-planner/seoOptimizerModule.js';
import {
  createDraftWriterModule,
  createDraftWriterModuleBinding,
} from '@/modules/writer/draftWriterModule.js';
import {
  createReviewerModule,
  createReviewerModuleBinding,
} from '@/modules/reviewer-technical/reviewerModule.js';
import {
  createHumanizerModule,
  createHumanizerModuleBinding,
} from '@/modules/humanizer/humanizerModule.js';
import {
  createContentAssetsPlannerModule,
  createContentAssetsPlannerModuleBinding,
} from '@/modules/content-assets-planner/contentAssetsPlannerModule.js';
import {
  createPublisherModule,
  createPublisherModuleBinding,
} from '@/modules/publisher/publisherModule.js';
import {
  createImagePlannerModule,
  createImagePlannerModuleBinding,
} from '@/modules/image-planner/imagePlannerModule.js';
import {
  createImageUploadModule,
  createImageUploadModuleBinding,
} from '@/modules/image-upload/imageUploadModule.js';
import {
  createInternalLinksModule,
  createInternalLinksModuleBinding,
} from '@/modules/internal-links/internalLinksModule.js';
import {
  createPortableTextModule,
  createPortableTextModuleBinding,
} from '@/modules/portable-text/portableTextModule.js';
import {
  createFaqGeneratorModule,
  createFaqGeneratorModuleBinding,
} from '@/modules/faq-generator/faqGeneratorModule.js';
import {
  createStructuredDataCheckModule,
  createStructuredDataCheckModuleBinding,
} from '@/modules/structured-data-check/structuredDataCheckModule.js';
import {
  createSanityBuilderModule,
  createSanityBuilderModuleBinding,
} from '@/modules/sanity-builder/sanityBuilderModule.js';
import {
  createSeoReviewerModule,
  createSeoReviewerModuleBinding,
} from '@/modules/reviewer-seo/seoReviewerModule.js';
import { createQaModule, createQaModuleBinding } from '@/modules/qa/qaModule.js';
import {
  createImproverModule,
  createImproverModuleBinding,
} from '@/modules/improver/improverModule.js';
import { createSanityWriteClient } from '@/integrations/sanity/sanityWriteClient.js';
import { createSanityReadClient } from '@/integrations/sanity/sanityReadClient.js';
import type { PublishGateway } from '@/modules/publisher/publisherModule.js';
import { createReviewLoopPolicy } from '@/cli/reviewLoopPolicy.js';

/** Sanity API version matching the website (`knowledge/sanity-schema.md`). */
const SANITY_API_VERSION = '2026-06-14';

// ============================================================================
// CLI Argument Schema
// ============================================================================

const ResumeArgsSchema = z.object({
  runId: z.string().trim().min(1),
  profile: z.string().trim().optional(),
});

type ResumeArgs = z.infer<typeof ResumeArgsSchema>;

// ============================================================================
// Pipeline Services
// ============================================================================

type PipelineServices = {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
  /** Real-publish boundary (idempotent Sanity writes + asset upload). */
  readonly publishGateway?: PublishGateway | undefined;
  /** Resolves internal-link candidate slugs to real post ids. */
  readonly postLookup?:
    | { readonly findPostIdBySlug: (slug: string) => Promise<string | null> }
    | undefined;
};

// ============================================================================
// Output Formatting
// ============================================================================

interface ResumeSummary {
  readonly runId: string;
  readonly status: 'success' | 'failed' | 'not_found' | 'paused';
  readonly topic: string;
  readonly resumedFrom: readonly string[];
  readonly completedModules: readonly string[];
  readonly pendingModules: readonly string[];
  readonly totalDurationMs: number;
  readonly totalCostUsd: number;
  readonly error?: string | undefined;
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
    .register(createPublisherModule())
    .register(createImagePlannerModule())
    .register(createImageUploadModule())
    .register(createInternalLinksModule())
    .register(createPortableTextModule())
    .register(createFaqGeneratorModule())
    .register(createStructuredDataCheckModule())
    .register(createSanityBuilderModule())
    .register(createSeoReviewerModule())
    .register(createQaModule())
    .register(createImproverModule());
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
    createImagePlannerModuleBinding(),
    createImageUploadModuleBinding(),
    createInternalLinksModuleBinding(),
    createPortableTextModuleBinding(),
    createFaqGeneratorModuleBinding(),
    createStructuredDataCheckModuleBinding(),
    createSanityBuilderModuleBinding(),
    createSeoReviewerModuleBinding(),
    createQaModuleBinding(),
    createImproverModuleBinding(),
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

async function initializePipeline(
  tier: ModelTier = 'STANDARD',
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<PipelineContext> {
  const appConfig = loadConfig();

  // Bind the requested Client Profile onto the configuration.
  const profile = resolveClientProfile(profileId);
  const config = applyClientProfile(appConfig, profile);
  const promptRegistry = createPromptRegistry();
  const stateStore = new StateStore();
  await stateStore.initialize();

  const llmProvider = getProvider(tier, config);

  const readClient = createSanityReadClient({
    projectId: config.sanityProjectId,
    dataset: config.sanityDataset,
    apiVersion: SANITY_API_VERSION,
  });
  const writeClient = createSanityWriteClient({
    projectId: config.sanityProjectId,
    dataset: config.sanityDataset,
    apiVersion: SANITY_API_VERSION,
    token: config.sanityWriteToken,
  });

  const services: PipelineServices = {
    llmProvider,
    promptRegistry,
    publishGateway: {
      isSlugUnique: (slug: string) => readClient.isSlugUnique(slug),
      uploadImageAsset: async (buffer: Uint8Array, filename: string) => {
        const uploaded = await writeClient.uploadImageAsset(Buffer.from(buffer), filename);
        return { assetId: uploaded.assetId };
      },
      createPost: async (document) => {
        const created = await writeClient.createPost(document);
        return { documentId: created.documentId };
      },
    },
    postLookup: {
      findPostIdBySlug: (slug: string) =>
        readClient.findPostBySlug(slug).then((post) => post?._id ?? null),
    },
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
    pauseAfter: createPausePolicy(config),
    loopAfter: createReviewLoopPolicy(config),
  });

  return {
    config,
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

  // Preload the run, then wire the pipeline under the Client Profile that
  // created it (metadata.clientProfileId) so the same imageSource/run-set rules
  // govern the resume. An explicit --profile still wins.
  const preloadStore = new StateStore();
  await preloadStore.initialize();
  const preloadedState = await preloadStore.load(args.runId);

  const profileId = args.profile ?? preloadedState?.metadata.clientProfileId ?? DEFAULT_PROFILE_ID;
  const context = await initializePipeline(undefined, profileId);

  // Use the preloaded (already validated) snapshot; fall back to a fresh load.
  const state = preloadedState ?? (await context.stateStore.load(args.runId));

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

  // Check if already completed or paused
  if (state.metadata.status !== 'running') {
    if (state.metadata.status === 'awaiting_assets') {
      console.log(`\nRun ${args.runId} is paused — awaiting attached images.`);
      return {
        runId: args.runId,
        status: 'paused',
        topic: state.brief?.topic ?? 'Unknown',
        resumedFrom: [],
        completedModules: state.timings.map((t) => t.module),
        pendingModules: context.orchestrator.prepareResumePoint(state).pending,
        totalDurationMs: state.timings.reduce((sum, t) => sum + t.durationMs, 0),
        totalCostUsd: state.metrics.totalCostUsd,
        error: 'Run is awaiting images — run attach-images first.',
      };
    }

    console.log(`\nRun ${args.runId} is already in status: ${state.metadata.status}`);
    return {
      runId: args.runId,
      status: state.metadata.status === 'published' ? 'success' : 'failed',
      topic: state.brief?.topic ?? 'Unknown',
      resumedFrom: [],
      completedModules: state.timings.map((t) => t.module),
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
      completedModules: result.state.timings.map((t) => t.module),
      pendingModules: [],
      totalDurationMs,
      totalCostUsd,
    };

    printResumeSummary(summary);
    return summary;
  } else if (result.kind === 'paused') {
    const pausedLabel =
      result.status === 'awaiting_assets' ? 'awaiting attached images' : result.status;
    console.log(`\n⏸ Pipeline paused — ${pausedLabel}\n`);

    const summary: ResumeSummary = {
      runId: args.runId,
      status: 'paused',
      topic,
      resumedFrom: resumePoint.completed,
      completedModules: result.state.timings.map((t) => t.module),
      pendingModules: result.resumePoint.pending,
      totalDurationMs,
      totalCostUsd,
      error:
        result.status === 'awaiting_assets'
          ? 'Run is awaiting images — run attach-images before resuming again.'
          : undefined,
    };

    printResumeSummary(summary);
    return summary;
  } else {
    const errorMessage =
      result.kind === 'module-failure'
        ? `${result.module}: ${result.error.message}`
        : result.error.message;

    console.log('\n✗ Pipeline failed\n');

    const summary: ResumeSummary = {
      runId: args.runId,
      status: 'failed',
      topic,
      resumedFrom: resumePoint.completed,
      completedModules: result.executions.map((e) => e.module),
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
  console.log(
    `Status:        ${summary.status === 'success' ? '✓ Success' : summary.status === 'failed' ? '✗ Failed' : summary.status === 'paused' ? '⏸ Paused' : '? Not Found'}`,
  );
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
    if (typeof arg === 'string' && arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
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
    process.exit(summary.status === 'success' || summary.status === 'paused' ? 0 : 1);
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

// Run only when executed directly (skipped when imported by tests).
// import.meta.main is a Node ≥ 21.2 runtime value; @types/node hasn't typed it yet.
if ((import.meta as { main?: boolean }).main) {
  void main();
}

export { resumePipeline, type ResumeArgs, type ResumeSummary };
