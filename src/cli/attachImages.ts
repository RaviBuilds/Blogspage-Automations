/**
 * Pipeline CLI - Attach Images (human-in-the-loop image handoff)
 *
 * The manual-image gateway (`21-cost-budget-modes-human-in-loop.md`,
 * `20-product-reselling-architecture.md`): after the Image Planner produces
 * `images.plan`, the pipeline pauses in `awaiting_assets`. The human drops one
 * file per planned image into a folder (each file named after the plan item's
 * `imageId`, e.g. `hero.png`, `inline-1.png`) and this command validates,
 * stages, and re-arms the run:
 *
 * Usage:
 *   node --import=tsx src/cli/attachImages.ts --run-id <runId> --dir <folder>
 *   node --import=tsx src/cli/attachImages.ts <runId> <folder>
 *
 * Files are copied into `storage/staging/<runId>/`, recorded in
 * `images.staged`, and the run returns to `running` so
 * `npm run resume -- --run-id <runId>` can continue.
 */

import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { FatalError, ValidationError } from '@/core/errors.js';
import {
  setPipelineStatus,
  type ImagePlanItem,
  type PipelineState,
  type StagedImage,
} from '@/core/state.js';
import { StateStore } from '@/core/stateStore.js';
import { assertSafeBasename } from '@/lib/fileHelpers.js';
import { isoNow } from '@/lib/dates.js';
import { readImageMetadata } from '@/lib/imageHelpers.js';

/** Default base directory for the human-in-the-loop handoff (`02-folder-structure.md`). */
const DEFAULT_STAGING_BASE = 'storage/staging';

const SUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
]);

/** The actor id recorded on every staged image (isolation from module writes). */
const ATTACH_ACTOR = 'cli:attach-images';

// ============================================================================
// CLI Argument Schema
// ============================================================================

export const AttachArgsSchema = z.object({
  runId: z.string().trim().min(1),
  dir: z.string().trim().min(1),
});

export type AttachArgs = z.infer<typeof AttachArgsSchema>;

// ============================================================================
// Attachment Summary
// ============================================================================

export interface AttachSummary {
  readonly runId: string;
  readonly status: 'success';
  readonly stagedCount: number;
  readonly stagingDir: string;
  readonly attachedImages: readonly string[];
}

/** Options for hermetic attachment (tests inject a temp StateStore/staging base). */
export interface AttachImagesOptions {
  readonly stateStore?: StateStore;
  readonly stagingBase?: string;
}

// ============================================================================
// Staging Helpers (pure and exported for tests)
// ============================================================================

/** The staging folder for one run: `<base>/<runId>`. */
export function stagingDirFor(runId: string, base: string = DEFAULT_STAGING_BASE): string {
  return join(base, runId);
}

/** One readable image file found in the attach folder. */
export interface AttachDirEntry {
  readonly filename: string;
  readonly stem: string;
  readonly extension: string;
}

/** Scans a folder for supported image files, ignoring subdirectories and other types. */
export async function scanAttachDir(dir: string): Promise<readonly AttachDirEntry[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new ValidationError('attach-images', [
      `Attach directory could not be read: ${errorMessage(error)}.`,
    ]);
  }

  const entries: AttachDirEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const extension = extensionOf(dirent.name);
    if (extension === undefined) continue;
    entries.push({
      filename: dirent.name,
      stem: dirent.name.slice(0, -(extension.length + 1)),
      extension,
    });
  }
  return Object.freeze(entries);
}

/**
 * Matches attached files to plan items by exact filename stem. Strict 1:1
 * coverage: every plan imageId needs exactly one file and every file must
 * correspond to a plan imageId.
 */
export function matchFilesToPlan(
  entries: readonly AttachDirEntry[],
  planItems: readonly ImagePlanItem[],
): ReadonlyMap<string, AttachDirEntry> {
  const planIds = new Set<string>();
  for (const item of planItems) {
    if (planIds.has(item.id)) {
      throw new ValidationError('attach-images', [
        `images.plan contains duplicate image id "${item.id}".`,
      ]);
    }
    planIds.add(item.id);
  }

  const byStem = new Map<string, AttachDirEntry>();
  for (const entry of entries) {
    const existing = byStem.get(entry.stem);
    if (existing !== undefined) {
      throw new ValidationError('attach-images', [
        `Multiple files match planned image "${entry.stem}": ${existing.filename} and ${entry.filename}.`,
      ]);
    }
    byStem.set(entry.stem, entry);
  }

  const unmatched = entries
    .filter((entry) => !planIds.has(entry.stem))
    .map((entry) => entry.filename);
  if (unmatched.length > 0) {
    throw new ValidationError('attach-images', [
      `File(s) do not match any image in the plan: ${unmatched.join(', ')}.`,
    ]);
  }

  const missing = [...planIds].filter((imageId) => !byStem.has(imageId));
  if (missing.length > 0) {
    throw new ValidationError('attach-images', [
      `Missing file(s) for planned image(s): ${missing.join(', ')}.`,
    ]);
  }

  return byStem;
}

// ============================================================================
// Attach Execution
// ============================================================================

/**
 * Validates, stages, and re-arms a manually-paused run.
 *
 * @throws {ValidationError} When the run is not in `awaiting_assets`, has no
 * plan, the folder mismatches the plan, or a file is not a supported image.
 */
export async function attachImages(
  args: AttachArgs,
  options: AttachImagesOptions = {},
): Promise<AttachSummary> {
  const stateStore = options.stateStore ?? new StateStore();
  await stateStore.initialize();

  const state: PipelineState | null = await stateStore.load(args.runId);
  if (state === null) {
    throw new FatalError('attach-images', `Run not found: ${args.runId}.`);
  }
  if (state.metadata.status !== 'awaiting_assets') {
    throw new ValidationError('attach-images', [
      `Run ${args.runId} is in status "${state.metadata.status}"; attach-images requires "awaiting_assets".`,
    ]);
  }
  const plan = state.images?.plan;
  if (plan === undefined) {
    throw new ValidationError('attach-images', [
      `Run ${args.runId} has no images.plan; the Image Planner must complete first.`,
    ]);
  }

  const entries = await scanAttachDir(args.dir);
  const matched = matchFilesToPlan(entries, plan.images);

  const stagingDir = stagingDirFor(args.runId, options.stagingBase);
  await mkdir(stagingDir, { recursive: true });

  const staged: StagedImage[] = [];
  const attached: string[] = [];

  for (const [imageId, entry] of matched) {
    const planItem = plan.images.find((item) => item.id === imageId);
    if (planItem === undefined) {
      throw new ValidationError('attach-images', [
        `Image plan item "${imageId}" was matched but is missing from images.plan.`,
      ]);
    }

    // Plan ids become filenames in the staging folder, so they must be safe.
    const safeStem = assertSafeBasename(imageId);
    const targetName = `${safeStem}.${entry.extension}`;
    const sourcePath = join(args.dir, entry.filename);
    const targetPath = join(stagingDir, targetName);

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(sourcePath));
    } catch (error) {
      throw new ValidationError('attach-images', [
        `Could not read "${entry.filename}": ${errorMessage(error)}.`,
      ]);
    }
    // Sanitize before staging — garbage files fail here with a clear message.
    const metadata = readImageMetadata(bytes);
    await copyFile(sourcePath, targetPath);

    staged.push(
      Object.freeze({
        imageId,
        role: planItem.role,
        localPath: targetPath,
        contentType: metadata.contentType,
        attachedBy: ATTACH_ACTOR,
        attachedAt: isoNow(),
      }),
    );
    attached.push(targetName);
  }

  const updated = setPipelineStatus(
    {
      ...state,
      images: {
        ...state.images,
        staged: Object.freeze(staged),
      },
    },
    'running',
  );
  await stateStore.save(updated);

  return Object.freeze({
    runId: args.runId,
    status: 'success' as const,
    stagedCount: staged.length,
    stagingDir,
    attachedImages: Object.freeze(attached),
  });
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function extensionOf(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || dot === lower.length - 1) {
    return undefined;
  }
  const extension = lower.slice(dot + 1);
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension) ? extension : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(): AttachArgs {
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

  if (positional && !args.runId) {
    args.runId = positional;
  }

  return AttachArgsSchema.parse(args);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    const summary = await attachImages(args);

    console.log('\n' + '='.repeat(60));
    console.log('Images Attached');
    console.log('='.repeat(60));
    console.log(`Run ID:        ${summary.runId}`);
    console.log(`Images:        ${summary.stagedCount}`);
    console.log(`Staged in:     ${summary.stagingDir}`);
    console.log('\nNext step: resume the pipeline');
    console.log(`  npm run resume -- --run-id ${summary.runId}`);
    console.log('='.repeat(60));

    process.exit(0);
  } catch (error: unknown) {
    console.error('\n✗ attach-images failed:');
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
