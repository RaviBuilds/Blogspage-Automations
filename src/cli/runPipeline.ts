/**
 * Pipeline CLI - Run Command
 *
 * Executes a complete content automation pipeline from topic to PublishArtifact.
 * This is the primary entry point for running the pipeline.
 *
 * Usage:
 *   node --import=tsx src/cli/runPipeline.ts --topic "My Topic"
 *   node --import=tsx src/cli/runPipeline.ts --topic "My Topic" --keywords "kw1,kw2"
 *   node --import=tsx src/cli/runPipeline.ts --topic "My Topic" --provider openai
 *   node --import=tsx src/cli/runPipeline.ts --resume <runId>
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

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
import { createInitialState, type PipelineState } from '@/core/state.js';
import { StateStore } from '@/core/stateStore.js';
import type { Config, ModelTier } from '@/core/types.js';
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
import { createSanityWriteClient } from '@/integrations/sanity/sanityWriteClient.js';
import { createSanityReadClient } from '@/integrations/sanity/sanityReadClient.js';
import type { PublishGateway } from '@/modules/publisher/publisherModule.js';

/** Sanity API version matching the website (`knowledge/sanity-schema.md`). */
const SANITY_API_VERSION = '2026-06-14';

// ============================================================================
// CLI Argument Schema
// ============================================================================

const CliArgsSchema = z.object({
  topic: z.string().trim().min(1).optional(),
  keywords: z.string().trim().optional(),
  provider: z.enum(['anthropic', 'openai', 'gemini', 'openrouter', 'local']).optional(),
  resume: z.string().trim().min(1).optional(),
  output: z.string().trim().optional(),
  sheetRowId: z.string().trim().optional(),
  targetAudience: z.string().trim().optional(),
  profile: z.string().trim().optional(),
});

type CliArgs = z.infer<typeof CliArgsSchema>;

// ============================================================================
// Pipeline Services
// ============================================================================

/**
 * Services container injected into all modules.
 * This is the composition root for the entire pipeline.
 */
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

interface PipelineSummary {
  readonly runId: string;
  readonly status: 'success' | 'failed' | 'paused';
  readonly topic: string;
  readonly totalDurationMs: number;
  readonly totalCostUsd: number;
  readonly moduleCount: number;
  readonly pendingModules?: readonly string[] | undefined;
  readonly artifactPath?: string;
  readonly error?: string;
  readonly moduleTimings: readonly {
    readonly module: string;
    readonly durationMs: number;
  }[];
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

/**
 * Registers all production modules with the registry.
 * This is the complete module graph for the content pipeline.
 */
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
    .register(createSanityBuilderModule());
}

/**
 * Creates all module bindings for the orchestrator.
 * Each binding translates between module I/O and PipelineState.
 */
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
  ];
}

// ============================================================================
// Pipeline Initialization
// ============================================================================

interface PipelineContext {
  readonly config: Config;
  readonly stateStore: StateStore;
  readonly promptRegistry: DevelopmentPromptRegistry;
  readonly registry: ModuleRegistry<PipelineServices>;
  readonly runner: ModuleRunner<PipelineServices>;
  readonly orchestrator: PipelineOrchestrator<PipelineServices>;
}

/**
 * Creates and wires all pipeline components.
 * This is the composition root.
 */
async function initializePipeline(
  tier: ModelTier = 'STANDARD',
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<PipelineContext> {
  // Load and validate configuration
  const appConfig = loadConfig();

  // Bind the requested Client Profile onto the configuration.
  const profile = resolveClientProfile(profileId);
  const config = applyClientProfile(appConfig, profile);

  // Initialize prompt registry
  const promptRegistry = createPromptRegistry();

  // Initialize state store
  const stateStore = new StateStore();
  await stateStore.initialize();

  // Create LLM provider for the requested tier
  const llmProvider = getProvider(tier, config);

  // Create services container
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

  // Create and register all modules
  const registry = createModuleRegistry<PipelineServices>();
  registerAllModules(registry);

  // Create module runner
  const runner = new ModuleRunner({ registry });

  // Create orchestrator with all bindings
  const bindings = createAllModuleBindings();
  const orchestrator = new PipelineOrchestrator({
    registry,
    runner,
    stateStore,
    services,
    bindings,
    pauseAfter: createPausePolicy(config),
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
// Artifact Persistence
// ============================================================================

const DEFAULT_OUTPUT_DIR = 'storage/artifacts';

/**
 * Saves the publish artifact to disk.
 */
async function saveArtifact(
  state: PipelineState,
  outputDir: string = DEFAULT_OUTPUT_DIR,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const filename = `${state.metadata.runId}.artifact.json`;
  const filepath = resolve(outputDir, filename);

  // Extract the publish artifact from state (if present)
  // In the current architecture, the Publisher module outputs PublishArtifact
  // which gets projected to a minimal PublishSection in state.
  // For now, we save the full state for debugging purposes.

  await writeFile(filepath, JSON.stringify(state, null, 2), 'utf-8');

  return filepath;
}

// ============================================================================
// Progress Reporting
// ============================================================================

function printSummary(summary: PipelineSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('Pipeline Execution Summary');
  console.log('='.repeat(60));
  console.log(`Run ID:        ${summary.runId}`);
  console.log(`Status:        ${summary.status === 'success' ? '✓ Success' : '✗ Failed'}`);
  console.log(`Topic:         ${summary.topic}`);
  console.log(`Duration:      ${formatDuration(summary.totalDurationMs)}`);
  console.log(`Total Cost:    ${formatCost(summary.totalCostUsd)}`);
  console.log(`Modules Run:   ${summary.moduleCount}`);

  if (summary.artifactPath) {
    console.log(`Artifact:      ${summary.artifactPath}`);
  }

  if (summary.error) {
    console.log(`Error:         ${summary.error}`);
  }

  console.log('\nModule Timings:');
  for (const timing of summary.moduleTimings) {
    console.log(`  ${timing.module.padEnd(25)} ${formatDuration(timing.durationMs)}`);
  }

  console.log('='.repeat(60));
}

function printPausedSummary(summary: PipelineSummary): void {
  console.log('\n' + '='.repeat(60));
  console.log('Pipeline Paused \u2014 awaiting human action');
  console.log('='.repeat(60));
  console.log(`Run ID:        ${summary.runId}`);
  console.log(`Status:        \u25cb ${summary.status}`);
  console.log(`Topic:         ${summary.topic}`);
  console.log(`Duration:      ${formatDuration(summary.totalDurationMs)}`);
  console.log(`Total Cost:    ${formatCost(summary.totalCostUsd)}`);
  console.log(`Modules Run:   ${summary.moduleCount}`);

  if (summary.artifactPath) {
    console.log(`Artifact:      ${summary.artifactPath}`);
  }

  if (summary.pendingModules && summary.pendingModules.length > 0) {
    console.log('\nPending Modules:');
    for (const module of summary.pendingModules) {
      console.log(`  \u25cb ${module}`);
    }
  }

  console.log('\nNext step: attach the planned images, then resume');
  console.log(`  npm run attach-images -- --run-id "${summary.runId}" --dir <folder-of-images>`);
  console.log(`  npm run resume -- --run-id ${summary.runId}`);
  console.log('='.repeat(60));
}

// ============================================================================
// Interactive Topic Prompt
// ============================================================================

async function promptForTopic(): Promise<string> {
  // Simple stdin-based prompt (no external dependencies)
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('Enter topic: ', (answer: string) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed.length === 0) {
        reject(new Error('Topic is required'));
      } else {
        resolve(trimmed);
      }
    });
  });
}

// ============================================================================
// Main Pipeline Execution
// ============================================================================

/**
 * Executes the complete pipeline for a topic.
 */
async function runPipeline(args: CliArgs): Promise<PipelineSummary> {
  const startedAt = Date.now();
  let topic = args.topic ?? '';

  // If no topic provided, prompt interactively
  if (!topic && !args.resume) {
    try {
      topic = await promptForTopic();
    } catch (_error) {
      throw new FatalError('cli', 'Topic is required. Use --topic or provide interactively.');
    }
  }

  // Initialize pipeline
  const tier: ModelTier = args.provider ? mapProviderToTier(args.provider) : 'STANDARD';
  const profileId: string = args.profile ?? DEFAULT_PROFILE_ID;
  const context = await initializePipeline(tier, profileId);

  // Create or load initial state
  let initialState: PipelineState;

  if (args.resume) {
    const loadedState = await context.stateStore.load(args.resume);
    if (loadedState === null) {
      throw new FatalError('cli', `Run not found: ${args.resume}`);
    }
    initialState = loadedState;
    topic = initialState.brief?.topic ?? 'Unknown topic';
    console.log(`\nResuming run: ${args.resume}`);
    console.log(`Topic: ${topic}\n`);
  } else {
    // Create initial state with brief
    const keywords =
      args.keywords
        ?.split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0) ?? [];
    initialState = createInitialState({
      sheetRowId: args.sheetRowId ?? `cli-${randomUUID().slice(0, 8)}`,
      clientProfileId: profileId,
    });

    // Add the brief
    initialState = {
      ...initialState,
      brief: {
        topic,
        sheetRowId: initialState.metadata.sheetRowId,
        targetAudience: args.targetAudience,
        keywordHints: keywords.length > 0 ? keywords : undefined,
      },
    };
  }

  const runId = initialState.metadata.runId;

  console.log('\n' + '='.repeat(60));
  console.log('Starting Pipeline');
  console.log('='.repeat(60));
  console.log(`Run ID:        ${runId}`);
  console.log(`Topic:         ${topic}`);
  console.log(`Provider:      ${context.config.models.STANDARD.provider}`);
  console.log(`Model:         ${context.config.models.STANDARD.modelId}`);
  console.log(`Profile:       ${context.config.profileId ?? DEFAULT_PROFILE_ID}`);
  console.log('='.repeat(60) + '\n');

  // Execute pipeline with progress reporting
  const result: OrchestrationResult = await context.orchestrator.execute(initialState);

  // Process results
  const totalDurationMs = Date.now() - startedAt;
  const totalCostUsd = result.state.metrics.totalCostUsd;
  const moduleTimings = result.state.timings.map((t) => ({
    module: t.module,
    durationMs: t.durationMs,
  }));

  if (result.ok) {
    // Save artifact
    const artifactPath = await saveArtifact(result.state, args.output);

    const summary: PipelineSummary = {
      runId,
      status: 'success',
      topic,
      totalDurationMs,
      totalCostUsd,
      moduleCount: result.executions.length,
      artifactPath,
      moduleTimings,
    };

    printSummary(summary);
    return summary;
  } else if (result.kind === 'paused') {
    // The run stopped at a human checkpoint (e.g. awaiting_assets) — keep its
    // artifact for review and print the handoff instructions.
    const artifactPath = await saveArtifact(result.state, args.output);

    const summary: PipelineSummary = {
      runId,
      status: 'paused',
      topic,
      totalDurationMs,
      totalCostUsd,
      moduleCount: result.executions.length,
      pendingModules: result.resumePoint.pending,
      artifactPath,
      moduleTimings,
    };

    printPausedSummary(summary);
    return summary;
  } else {
    const errorMessage =
      result.kind === 'module-failure'
        ? `${result.module}: ${result.error.message}`
        : result.error.message;

    const summary: PipelineSummary = {
      runId,
      status: 'failed',
      topic,
      totalDurationMs,
      totalCostUsd,
      moduleCount: result.executions.length,
      error: errorMessage,
      moduleTimings,
    };

    printSummary(summary);
    return summary;
  }
}

/**
 * Maps a provider name to a model tier.
 * For simplicity, we use STANDARD tier for all providers.
 * A more sophisticated implementation could support tier selection.
 */
function mapProviderToTier(_provider: CliArgs['provider']): ModelTier {
  // In a full implementation, this would configure the model spec
  // to use the specified provider. For now, all providers use STANDARD tier.
  return 'STANDARD';
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function parseArgs(): CliArgs {
  const args: Record<string, string> = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (typeof arg === 'string' && arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = process.argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      }
    }
  }

  return CliArgsSchema.parse(args);
}

async function main(): Promise<void> {
  // Load environment variables from .env file
  config();

  try {
    const args = parseArgs();
    const summary = await runPipeline(args);

    // Exit with appropriate code
    process.exit(summary.status === 'success' || summary.status === 'paused' ? 0 : 1);
  } catch (error: unknown) {
    console.error('\n✗ Pipeline failed:');
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

// Run if executed directly
// Run only when executed directly (skipped when imported by tests).
// import.meta.main is a Node ≥ 21.2 runtime value; @types/node hasn't typed it yet.
if ((import.meta as { main?: boolean }).main) {
  void main();
}

// Export for testing
export {
  runPipeline,
  initializePipeline,
  registerAllModules,
  createAllModuleBindings,
  type CliArgs,
  type PipelineSummary,
  type PipelineServices,
};
