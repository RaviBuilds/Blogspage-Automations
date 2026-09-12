/**
 * Pipeline CLI - Validate Config Command
 *
 * Validates the pipeline configuration, environment variables, and module setup
 * without executing any LLM calls or external API requests.
 *
 * Usage:
 *   node --import=tsx src/cli/validateConfig.ts
 *   node --import=tsx src/cli/validateConfig.ts --verbose
 *   node --import=tsx src/cli/validateConfig.ts --check-prompts
 */

import { config } from 'dotenv';
import { z } from 'zod';

import { loadConfig, requiredEnvironmentKeys } from '@/config/env.js';
import { DEFAULT_MODELS, DEFAULT_IMAGE_MODEL } from '@/config/models.js';
import { FatalError } from '@/core/errors.js';
import { createModuleRegistry, type PipelineModule } from '@/core/moduleRunner.js';
import type { LLMProvider } from '@/providers/llm/LLMProvider.js';
import {
  createPromptRegistry,
  type DevelopmentPromptRegistry,
  type PromptRegistry,
} from '@/prompts/registry.js';
import { PROMPT_KEYS } from '@/prompts/registry.js';

// Import all production modules and their bindings
import { createResearchModule } from '@/modules/research/researchModule.js';
import { createPlannerModule } from '@/modules/planner/plannerModule.js';
import { createSEOOptimizerModule } from '@/modules/seo-planner/seoOptimizerModule.js';
import { createDraftWriterModule } from '@/modules/writer/draftWriterModule.js';
import { createReviewerModule } from '@/modules/reviewer-technical/reviewerModule.js';
import { createHumanizerModule } from '@/modules/humanizer/humanizerModule.js';
import { createContentAssetsPlannerModule } from '@/modules/content-assets-planner/contentAssetsPlannerModule.js';
import { createPublisherModule } from '@/modules/publisher/publisherModule.js';
import { createImagePlannerModule } from '@/modules/image-planner/imagePlannerModule.js';
import { createImageUploadModule } from '@/modules/image-upload/imageUploadModule.js';
import { createInternalLinksModule } from '@/modules/internal-links/internalLinksModule.js';
import { createPortableTextModule } from '@/modules/portable-text/portableTextModule.js';
import { createFaqGeneratorModule } from '@/modules/faq-generator/faqGeneratorModule.js';
import { createStructuredDataCheckModule } from '@/modules/structured-data-check/structuredDataCheckModule.js';
import { createSanityBuilderModule } from '@/modules/sanity-builder/sanityBuilderModule.js';

// ============================================================================
// CLI Argument Schema
// ============================================================================

const ValidateArgsSchema = z.object({
  verbose: z.coerce.boolean().optional().default(false),
  checkPrompts: z.coerce.boolean().optional().default(false),
  json: z.coerce.boolean().optional().default(false),
});

type ValidateArgs = z.infer<typeof ValidateArgsSchema>;

// ============================================================================
// Validation Result
// ============================================================================

interface ValidationResult {
  readonly valid: boolean;
  readonly environment: EnvironmentValidation;
  readonly config: ConfigValidation;
  readonly modules: ModulesValidation;
  readonly prompts?: PromptsValidation | undefined;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface EnvironmentValidation {
  readonly valid: boolean;
  readonly missing: readonly string[];
  readonly present: readonly string[];
}

interface ConfigValidation {
  readonly valid: boolean;
  readonly models: readonly ModelValidation[];
  readonly imageModel: ModelValidation;
}

interface ModelValidation {
  readonly tier: string;
  readonly provider: string;
  readonly modelId: string;
  readonly valid: boolean;
  readonly error?: string;
}

interface ModulesValidation {
  readonly valid: boolean;
  readonly count: number;
  readonly modules: readonly ModuleValidation[];
  readonly dependencies: readonly DependencyValidation[];
}

interface ModuleValidation {
  readonly key: string;
  readonly displayName: string;
  readonly dependencies: readonly string[];
  readonly valid: boolean;
}

interface DependencyValidation {
  readonly from: string;
  readonly to: string;
  readonly valid: boolean;
  readonly error?: string;
}

interface PromptsValidation {
  readonly valid: boolean;
  readonly prompts: readonly PromptValidation[];
}

interface PromptValidation {
  readonly key: string;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly error?: string;
}

/** Services container the validator's registry is typed against (mirrors the run/resume CLIs). */
type PipelineServices = {
  readonly llmProvider: LLMProvider;
  readonly promptRegistry: PromptRegistry;
};

// ============================================================================
// Validation Functions
// ============================================================================

function validateEnvironment(): EnvironmentValidation {
  const missing: string[] = [];
  const present: string[] = [];

  for (const key of requiredEnvironmentKeys) {
    const value = process.env[key];
    if (value === undefined || value.trim().length === 0) {
      missing.push(key);
    } else {
      present.push(key);
    }
  }

  return {
    valid: missing.length === 0,
    missing: Object.freeze(missing),
    present: Object.freeze(present),
  };
}

function validateConfig(): ConfigValidation {
  const models: ModelValidation[] = [];
  const allValid = true;

  // Validate each model tier
  const tiers: readonly ('CHEAP' | 'STANDARD' | 'PREMIUM')[] = ['CHEAP', 'STANDARD', 'PREMIUM'];

  for (const tier of tiers) {
    const spec = DEFAULT_MODELS[tier];
    const validation: ModelValidation = {
      tier,
      provider: spec.provider,
      modelId: spec.modelId,
      valid: true,
    };
    models.push(validation);
  }

  // Validate image model
  const imageModelValidation: ModelValidation = {
    tier: 'IMAGE',
    provider: DEFAULT_IMAGE_MODEL.provider,
    modelId: DEFAULT_IMAGE_MODEL.modelId,
    valid: true,
  };

  return {
    valid: allValid,
    models: Object.freeze(models),
    imageModel: imageModelValidation,
  };
}

function validateModules(): ModulesValidation {
  const errors: string[] = [];
  const modules: ModuleValidation[] = [];
  const dependencies: DependencyValidation[] = [];

  // Create registry and register all modules
  const registry = createModuleRegistry<PipelineServices>();

  const moduleFactories = [
    createResearchModule,
    createPlannerModule,
    createSEOOptimizerModule,
    createDraftWriterModule,
    createReviewerModule,
    createHumanizerModule,
    createContentAssetsPlannerModule,
    createPublisherModule,
    createImagePlannerModule,
    createImageUploadModule,
    createInternalLinksModule,
    createPortableTextModule,
    createFaqGeneratorModule,
    createStructuredDataCheckModule,
    createSanityBuilderModule,
  ];

  for (const factory of moduleFactories) {
    try {
      const module = factory();
      const metadata = module.metadata;

      modules.push({
        key: metadata.key,
        displayName: metadata.displayName,
        dependencies: metadata.dependencies,
        valid: true,
      });

      // validateConfig only creates modules to prove they can be built and to
      // derive their metadata/dependency graph — it never executes them. The
      // cast is therefore safe and avoids TS's strict lifecycle-hook variance
      // over the heterogeneous module union.
      registry.register(module as unknown as PipelineModule<unknown, unknown, PipelineServices>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to create module: ${message}`);
    }
  }

  // Validate dependency graph
  let graphValid = true;
  try {
    const graph = registry.dependencyGraph();

    // Check that all dependencies are satisfied
    for (const key of graph.nodes) {
      const deps = graph.dependenciesOf(key);
      for (const dep of deps) {
        dependencies.push({
          from: key,
          to: dep,
          valid: true,
        });
      }
    }
  } catch (error) {
    graphValid = false;
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Dependency graph validation failed: ${message}`);
  }

  return {
    valid: modules.every((m) => m.valid) && graphValid,
    count: modules.length,
    modules: Object.freeze(modules),
    dependencies: Object.freeze(dependencies),
  };
}

async function validatePrompts(
  promptRegistry: DevelopmentPromptRegistry,
): Promise<PromptsValidation> {
  const prompts: PromptValidation[] = [];
  let allValid = true;

  for (const key of PROMPT_KEYS) {
    try {
      // Attempt to resolve the prompt (without variables - will fail but proves file exists)
      await promptRegistry.diagnose(key, {});
      prompts.push({
        key,
        exists: true,
        valid: true,
      });
    } catch (error) {
      // File exists but validation failed (expected without proper variables)
      const message = error instanceof Error ? error.message : String(error);
      const isMissingFile = message.includes('not found') || message.includes('ENOENT');

      prompts.push({
        key,
        exists: !isMissingFile,
        valid: false,
        error: isMissingFile ? 'Prompt files not found' : 'Validation failed',
      });

      if (isMissingFile) {
        allValid = false;
      }
    }
  }

  return {
    valid: allValid,
    prompts: Object.freeze(prompts),
  };
}

async function runValidation(args: ValidateArgs): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Validate environment
  const environment = validateEnvironment();
  if (!environment.valid) {
    errors.push(`Missing required environment variables: ${environment.missing.join(', ')}`);
  }

  // 2. Validate config
  const configValidation = validateConfig();

  // 3. Validate modules
  const modulesValidation = validateModules();
  if (!modulesValidation.valid) {
    errors.push('Module validation failed');
  }

  // 4. Optionally validate prompts
  let promptsValidation: PromptsValidation | undefined;
  if (args.checkPrompts) {
    try {
      const promptRegistry = createPromptRegistry();
      promptsValidation = await validatePrompts(promptRegistry);
      if (!promptsValidation.valid) {
        warnings.push('Some prompts have validation issues');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Prompt validation skipped: ${message}`);
    }
  }

  // 5. Try loading full config
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof FatalError) {
      errors.push(error.message);
    } else if (error instanceof Error) {
      errors.push(error.message);
    }
  }

  return {
    valid: errors.length === 0,
    environment,
    config: configValidation,
    modules: modulesValidation,
    prompts: promptsValidation,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  };
}

// ============================================================================
// Output Formatting
// ============================================================================

function printValidation(result: ValidationResult, verbose: boolean): void {
  console.log('\n' + '='.repeat(60));
  console.log('Configuration Validation');
  console.log('='.repeat(60));

  // Overall status
  const statusIcon = result.valid ? '✓' : '✗';
  console.log(`\n${statusIcon} Overall: ${result.valid ? 'VALID' : 'INVALID'}`);

  // Environment
  console.log(`\nEnvironment Variables:`);
  if (result.environment.valid) {
    console.log(`  ✓ All required variables present`);
  } else {
    console.log(`  ✗ Missing: ${result.environment.missing.join(', ')}`);
  }

  if (verbose) {
    console.log(`  Present: ${result.environment.present.join(', ')}`);
  }

  // Config
  console.log(`\nModel Configuration:`);
  for (const model of result.config.models) {
    const icon = model.valid ? '✓' : '✗';
    console.log(`  ${icon} ${model.tier}: ${model.provider}/${model.modelId}`);
  }
  const imageIcon = result.config.imageModel.valid ? '✓' : '✗';
  console.log(
    `  ${imageIcon} IMAGE: ${result.config.imageModel.provider}/${result.config.imageModel.modelId}`,
  );

  // Modules
  console.log(`\nModules (${result.modules.count} registered):`);
  for (const module of result.modules.modules) {
    const icon = module.valid ? '✓' : '✗';
    const deps =
      module.dependencies.length > 0 ? ` (depends on: ${module.dependencies.join(', ')})` : '';
    console.log(`  ${icon} ${module.key}${verbose ? deps : ''}`);
  }

  // Prompts (if checked)
  if (result.prompts) {
    console.log(`\nPrompts (${result.prompts.prompts.length} registered):`);
    for (const prompt of result.prompts.prompts) {
      const icon = prompt.valid ? '✓' : prompt.exists ? '⚠' : '✗';
      console.log(`  ${icon} ${prompt.key}`);
      if (verbose && prompt.error) {
        console.log(`      ${prompt.error}`);
      }
    }
  }

  // Errors
  if (result.errors.length > 0) {
    console.log(`\nErrors:`);
    for (const error of result.errors) {
      console.log(`  ✗ ${error}`);
    }
  }

  // Warnings
  if (result.warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const warning of result.warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

function printJson(result: ValidationResult): void {
  console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function parseArgs(): ValidateArgs {
  const args: Record<string, string> = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (typeof arg === 'string' && arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'verbose' || key === 'check-prompts' || key === 'json') {
        const normalizedKey = key.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
        args[normalizedKey] = 'true';
      } else {
        const value = process.argv[i + 1];
        if (value && !value.startsWith('--')) {
          args[key] = value;
          i++;
        }
      }
    }
  }

  return ValidateArgsSchema.parse(args);
}

async function main(): Promise<void> {
  config();

  try {
    const args = parseArgs();
    const result = await runValidation(args);

    if (args.json) {
      printJson(result);
    } else {
      printValidation(result, args.verbose);
    }

    process.exit(result.valid ? 0 : 1);
  } catch (error: unknown) {
    console.error('\n✗ Validation failed:');
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

export {
  runValidation,
  validateEnvironment,
  validateConfig,
  validateModules,
  validatePrompts,
  type ValidateArgs,
  type ValidationResult,
  type EnvironmentValidation,
  type ConfigValidation,
  type ModulesValidation,
  type PromptsValidation,
};
