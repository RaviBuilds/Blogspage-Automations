/**
 * The Prompt Registry — the single, module-facing source of truth for every
 * prompt in the system. Modules ask for a prompt set by registry key only;
 * they never construct a file path, and an invalid prompt can never reach
 * a provider through {@link PromptRegistry.get}.
 */
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { FatalError, ValidationError } from '@/core/errors.js';
import { AsyncCache } from '@/lib/cache.js';
import { resolvePromptSet } from '@/lib/prompts.js';
import type {
  IncludedFragment,
  PromptFileSource,
  PromptResolution,
  PromptSourceInfo,
  PromptValidationIssue,
} from '@/lib/prompts.js';
import { estimateTokenCount } from '@/lib/tokenCount.js';

const execFileAsync = promisify(execFile);

/** The registry keys that have an authored prompt folder under src/prompts/. */
export const PROMPT_KEYS = [
  'research',
  'planner',
  'seo-planner',
  'writer',
  'reviewer-technical',
  'reviewer-seo',
  'humanizer',
  'content-assets-planner',
  'qa',
  'improver',
  'image-planner',
  'image-validator',
  'internal-links',
  'faq-generator',
] as const;

/** A compile-time-checked prompt registry key, generated from the folders above. */
export type PromptKey = (typeof PROMPT_KEYS)[number];

/**
 * The fully assembled, provider-ready prompt for one registry key.
 * `examples`, `validation`, and `repair` are present only for the keys whose
 * documented file inventory includes that role.
 */
export interface PromptSet {
  readonly system: string;
  readonly user: string;
  readonly examples?: string;
  readonly validation?: string;
  readonly repair?: string;
  /** Short git commit hash of the prompt folder at load time. */
  readonly promptVersion: string;
}

/** One cache entry's status, as surfaced to local development diagnostics. */
export interface PromptCacheStatusEntry {
  readonly logicalPath: string;
  readonly cached: boolean;
}

/** Local, model-independent approximate token counts for one resolution. */
export interface PromptTokenEstimate {
  readonly system: number;
  readonly user: number;
  readonly examples: number;
  readonly validation: number;
  readonly repair: number;
  readonly total: number;
}

/**
 * A full inspection of one registry key's resolution — valid or not. Intended
 * for local development and prompt debugging only; never calls a provider.
 */
export interface PromptDiagnostics {
  readonly registryKey: PromptKey;
  readonly promptVersion: string;
  readonly sources: readonly PromptSourceInfo[];
  readonly includedFragments: readonly IncludedFragment[];
  readonly system?: string | undefined;
  readonly user?: string | undefined;
  readonly examples?: string | undefined;
  readonly validation?: string | undefined;
  readonly repair?: string | undefined;
  readonly referencedVariables: readonly string[];
  readonly suppliedVariables: readonly string[];
  readonly missingVariables: readonly string[];
  readonly unusedVariables: readonly string[];
  readonly issues: readonly PromptValidationIssue[];
  readonly valid: boolean;
  readonly cacheStatus: readonly PromptCacheStatusEntry[];
  readonly estimatedTokens: PromptTokenEstimate;
}

/**
 * The module-facing contract, exactly as documented in
 * `13-prompt-management-system.md`. This is the entire prompt-loading
 * surface a module ever touches.
 */
export interface PromptRegistry {
  get(key: PromptKey, vars: Readonly<Record<string, string>>): Promise<PromptSet>;
}

/**
 * Local development and testing capabilities layered on top of the
 * module-facing registry. Never required by, or exposed to, module code.
 */
export interface PromptRegistryDiagnostics {
  diagnose(key: PromptKey, vars: Readonly<Record<string, string>>): Promise<PromptDiagnostics>;
  /** Clears every cached prompt file and resolved prompt version. */
  invalidateCache(): void;
}

/** The complete registry surface used by this project's own tooling and tests. */
export type DevelopmentPromptRegistry = PromptRegistry & PromptRegistryDiagnostics;

/** Resolves the promptVersion for one registry key. Injectable for testing. */
export type PromptVersionResolver = (key: PromptKey) => Promise<string>;

const PROMPTS_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Reads prompt files directly from disk, rooted at src/prompts/. */
class NodeFsPromptFileSource implements PromptFileSource {
  public constructor(private readonly rootDir: string) {}

  public async fileExists(logicalPath: string): Promise<boolean> {
    try {
      await access(this.resolveAbsolutePath(logicalPath));
      return true;
    } catch {
      return false;
    }
  }

  public async readFile(logicalPath: string): Promise<string> {
    return readFile(this.resolveAbsolutePath(logicalPath), 'utf8');
  }

  private resolveAbsolutePath(logicalPath: string): string {
    return resolve(this.rootDir, logicalPath);
  }
}

/**
 * Resolves the documented `git rev-parse --short HEAD -- src/prompts/<key>/`
 * promptVersion. Failing to resolve real git provenance is fatal: a prompt
 * version that silently fell back to a placeholder would defeat the whole
 * point of this field, which is exact run reproducibility.
 */
async function resolveGitPromptVersion(key: PromptKey): Promise<string> {
  const promptFolder = join(PROMPTS_ROOT, key);

  try {
    const { stdout } = await execFileAsync('git', [
      'rev-parse',
      '--short',
      'HEAD',
      '--',
      promptFolder,
    ]);
    const hash = stdout.trim();

    if (hash.length === 0) {
      throw new Error('git rev-parse returned an empty commit hash');
    }

    return hash;
  } catch (error) {
    throw new FatalError(
      'prompt-registry',
      `Could not resolve promptVersion for "${key}" via git: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertNoDuplicatePromptKeys(keys: readonly string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const key of keys) {
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }

  if (duplicates.size > 0) {
    throw new FatalError(
      'prompt-registry',
      `Duplicate registry key(s) detected: ${[...duplicates].sort((a, b) => a.localeCompare(b)).join(', ')}`,
    );
  }
}

// Fail loudly at module load time, not on first use, if the registry-key
// vocabulary itself is ever corrupted.
assertNoDuplicatePromptKeys(PROMPT_KEYS);

function isKnownPromptKey(key: string): key is PromptKey {
  return (PROMPT_KEYS as readonly string[]).includes(key);
}

function assertKnownPromptKey(key: string): void {
  if (!isKnownPromptKey(key)) {
    throw new FatalError('prompt-registry', `"${key}" is not a recognized prompt registry key.`);
  }
}

/** Construction options for {@link FilePromptRegistry}. Intended for tests. */
export interface PromptRegistryOptions {
  readonly fileSource?: PromptFileSource;
  readonly resolveVersion?: PromptVersionResolver;
}

/**
 * The concrete Prompt Registry. Resolves, validates, caches, and versions
 * every prompt file for every registry key, and never returns an invalid
 * {@link PromptSet} from {@link get}.
 */
export class FilePromptRegistry implements DevelopmentPromptRegistry {
  private readonly fileCache = new AsyncCache<string>();
  private readonly versionCache = new AsyncCache<string>();
  private readonly fileSource: PromptFileSource;
  private readonly resolveVersion: PromptVersionResolver;

  public constructor(options: PromptRegistryOptions = {}) {
    this.fileSource = options.fileSource ?? new NodeFsPromptFileSource(PROMPTS_ROOT);
    this.resolveVersion = options.resolveVersion ?? resolveGitPromptVersion;
  }

  /**
   * Returns a fully assembled, valid PromptSet for `key`.
   *
   * @throws {FatalError} When `key` is not a recognized registry key, or when
   * promptVersion cannot be resolved.
   * @throws {ValidationError} When the resolved prompt set has any missing
   * file, missing partial, circular partial, unresolved variable, unused
   * variable, or role/placeholder mismatch. No partially-valid PromptSet is
   * ever returned.
   */
  public async get(key: PromptKey, vars: Readonly<Record<string, string>>): Promise<PromptSet> {
    assertKnownPromptKey(key);
    const resolution = await this.resolve(key, vars);

    if (!resolution.valid || resolution.system === undefined || resolution.user === undefined) {
      throw new ValidationError(
        'prompt-registry',
        resolution.issues.map((issue) => issue.message),
      );
    }

    const promptVersion = await this.versionCache.getOrLoad(key, () => this.resolveVersion(key));

    return {
      system: resolution.system,
      user: resolution.user,
      promptVersion,
      ...(resolution.examples !== undefined ? { examples: resolution.examples } : {}),
      ...(resolution.validation !== undefined ? { validation: resolution.validation } : {}),
      ...(resolution.repair !== undefined ? { repair: resolution.repair } : {}),
    };
  }

  /**
   * Returns a full inspection of `key`'s resolution, valid or not. Never
   * throws for a content-validation defect — every issue found is returned
   * in the result instead. Makes no network or provider call.
   */
  public async diagnose(
    key: PromptKey,
    vars: Readonly<Record<string, string>>,
  ): Promise<PromptDiagnostics> {
    assertKnownPromptKey(key);
    const resolution = await this.resolve(key, vars);
    const promptVersion = await this.versionCache.getOrLoad(key, () => this.resolveVersion(key));

    return {
      registryKey: key,
      promptVersion,
      sources: resolution.sources,
      includedFragments: resolution.includedFragments,
      system: resolution.system,
      user: resolution.user,
      examples: resolution.examples,
      validation: resolution.validation,
      repair: resolution.repair,
      referencedVariables: resolution.referencedVariables,
      suppliedVariables: resolution.suppliedVariables,
      missingVariables: resolution.missingVariables,
      unusedVariables: resolution.unusedVariables,
      issues: resolution.issues,
      valid: resolution.valid,
      cacheStatus: this.buildCacheStatus(resolution),
      estimatedTokens: this.estimateTokens(resolution),
    };
  }

  /** Clears every cached prompt file and resolved prompt version. */
  public invalidateCache(): void {
    this.fileCache.clear();
    this.versionCache.clear();
  }

  private async resolve(
    key: PromptKey,
    vars: Readonly<Record<string, string>>,
  ): Promise<PromptResolution> {
    return resolvePromptSet(key, vars, {}, this.fileSource, (logicalPath) =>
      this.fileCache.getOrLoad(logicalPath, () => this.fileSource.readFile(logicalPath)),
    );
  }

  private buildCacheStatus(resolution: PromptResolution): readonly PromptCacheStatusEntry[] {
    const logicalPaths = new Set<string>();

    for (const source of resolution.sources) {
      logicalPaths.add(source.logicalPath);
    }

    for (const fragment of resolution.includedFragments) {
      logicalPaths.add(fragment.logicalPath);
    }

    return [...logicalPaths]
      .sort((a, b) => a.localeCompare(b))
      .map((logicalPath) => ({
        logicalPath,
        cached: this.fileCache.has(logicalPath),
      }));
  }

  private estimateTokens(resolution: PromptResolution): PromptTokenEstimate {
    const system = estimateTokenCount(resolution.system ?? '');
    const user = estimateTokenCount(resolution.user ?? '');
    const examples = estimateTokenCount(resolution.examples ?? '');
    const validation = estimateTokenCount(resolution.validation ?? '');
    const repair = estimateTokenCount(resolution.repair ?? '');

    return {
      system,
      user,
      examples,
      validation,
      repair,
      total: system + user + examples + validation + repair,
    };
  }
}

/** Creates the default, filesystem-backed Prompt Registry. */
export function createPromptRegistry(
  options: PromptRegistryOptions = {},
): DevelopmentPromptRegistry {
  return new FilePromptRegistry(options);
}
