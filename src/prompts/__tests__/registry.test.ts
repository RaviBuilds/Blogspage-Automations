import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FatalError, ValidationError } from '@/core/errors.js';
import {
  FilePromptRegistry,
  PROMPT_KEYS,
  createPromptRegistry,
  type PromptKey,
} from '@/prompts/registry.js';
import type { PromptFileSource } from '@/lib/prompts.js';

class FakePromptFileSource implements PromptFileSource {
  public constructor(private readonly files: Record<string, string>) {}

  public fileExists(logicalPath: string): Promise<boolean> {
    return Promise.resolve(logicalPath in this.files);
  }

  public readFile(logicalPath: string): Promise<string> {
    const content = this.files[logicalPath];
    if (content === undefined) {
      return Promise.reject(new Error(`No such file: ${logicalPath}`));
    }
    return Promise.resolve(content);
  }
}

const FIXED_VERSION = 'abc1234';

function createRegistry(files: Record<string, string>) {
  return new FilePromptRegistry({
    fileSource: new FakePromptFileSource(files),
    resolveVersion: () => Promise.resolve(FIXED_VERSION),
  });
}

describe('FilePromptRegistry.get', () => {
  it('returns a fully assembled PromptSet with promptVersion for a valid registry key', async () => {
    const registry = createRegistry({
      'writer/system.md': 'System instructions.',
      'writer/user.md': 'Write about {{topic}}.',
    });

    const result = await registry.get('writer', { topic: 'direct booking' });

    expect(result).toEqual({
      system: 'System instructions.',
      user: 'Write about direct booking.',
      promptVersion: FIXED_VERSION,
    });
  });

  it('includes examples, validation, and repair only when those files exist', async () => {
    const registry = createRegistry({
      'improver/system.md': 'System.',
      'improver/user.md': 'Task. {{repairInstructions}}',
      'improver/repair.md': 'Repair guidance.',
    });

    const result = await registry.get('improver', {});

    expect(result.examples).toBeUndefined();
    expect(result.validation).toBeUndefined();
    expect(result.repair).toBe('Repair guidance.');
    expect(result.user).toBe('Task. Repair guidance.');
  });

  it('throws ValidationError, never returning a partial PromptSet, when a required file is missing', async () => {
    const registry = createRegistry({
      'writer/system.md': 'System.',
    });

    await expect(registry.get('writer', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError listing every unresolved variable when interpolation is incomplete', async () => {
    const registry = createRegistry({
      'writer/system.md': 'System.',
      'writer/user.md': 'Needs {{alpha}} and {{beta}}.',
    });

    await expect(registry.get('writer', {})).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.details.some((detail) => detail.includes('alpha'))).toBe(true);
      expect(validationError.details.some((detail) => detail.includes('beta'))).toBe(true);
      return true;
    });
  });

  it('throws ValidationError when a shared partial is missing', async () => {
    const registry = createRegistry({
      'writer/system.md': '{{> shared/missing.md}}',
      'writer/user.md': 'Task.',
    });

    await expect(registry.get('writer', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when a partial reference is circular', async () => {
    const registry = createRegistry({
      'writer/system.md': '{{> shared/a.md}}',
      'writer/user.md': 'Task.',
      'shared/a.md': '{{> shared/a.md}}',
    });

    await expect(registry.get('writer', {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws FatalError for an unrecognized registry key', async () => {
    const registry = createRegistry({});

    await expect(registry.get('not-a-real-key' as PromptKey, {})).rejects.toBeInstanceOf(
      FatalError,
    );
  });

  it('propagates a FatalError from the version resolver without swallowing it', async () => {
    const registry = new FilePromptRegistry({
      fileSource: new FakePromptFileSource({
        'writer/system.md': 'System.',
        'writer/user.md': 'Task.',
      }),
      resolveVersion: () =>
        Promise.reject(new FatalError('prompt-registry', 'git provenance unavailable')),
    });

    await expect(registry.get('writer', {})).rejects.toBeInstanceOf(FatalError);
  });

  it('caches raw file reads across repeated get() calls for the same key', async () => {
    const fileSource = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Task.',
    });
    const readSpy = vi.spyOn(fileSource, 'readFile');
    const registry = new FilePromptRegistry({
      fileSource,
      resolveVersion: () => Promise.resolve(FIXED_VERSION),
    });

    await registry.get('writer', {});
    await registry.get('writer', {});

    const systemReadCount = readSpy.mock.calls.filter(
      ([path]) => path === 'writer/system.md',
    ).length;
    expect(systemReadCount).toBe(1);
  });

  it('resolves promptVersion only once per key across repeated get() calls', async () => {
    const resolveVersion = vi.fn().mockResolvedValue(FIXED_VERSION);
    const registry = new FilePromptRegistry({
      fileSource: new FakePromptFileSource({
        'writer/system.md': 'System.',
        'writer/user.md': 'Task.',
      }),
      resolveVersion,
    });

    await registry.get('writer', {});
    await registry.get('writer', {});

    expect(resolveVersion).toHaveBeenCalledTimes(1);
  });

  it('invalidateCache() forces the next call to reload files and re-resolve promptVersion', async () => {
    const fileSource = new FakePromptFileSource({
      'writer/system.md': 'Version one.',
      'writer/user.md': 'Task.',
    });
    const readSpy = vi.spyOn(fileSource, 'readFile');
    const resolveVersion = vi.fn().mockResolvedValue(FIXED_VERSION);
    const registry = new FilePromptRegistry({ fileSource, resolveVersion });

    await registry.get('writer', {});
    registry.invalidateCache();
    await registry.get('writer', {});

    const systemReadCount = readSpy.mock.calls.filter(
      ([path]) => path === 'writer/system.md',
    ).length;
    expect(systemReadCount).toBe(2);
    expect(resolveVersion).toHaveBeenCalledTimes(2);
  });
});

describe('FilePromptRegistry.diagnose', () => {
  it('returns full diagnostics for a valid prompt without throwing', async () => {
    const registry = createRegistry({
      'writer/system.md': '{{> shared/voice.md}}',
      'writer/user.md': 'Write about {{topic}}.',
      'shared/voice.md': 'Brand voice fragment.',
    });

    const diagnostics = await registry.diagnose('writer', { topic: 'direct booking' });

    expect(diagnostics.valid).toBe(true);
    expect(diagnostics.registryKey).toBe('writer');
    expect(diagnostics.promptVersion).toBe(FIXED_VERSION);
    expect(diagnostics.system).toBe('Brand voice fragment.');
    expect(diagnostics.user).toBe('Write about direct booking.');
    expect(diagnostics.includedFragments).toEqual([
      { logicalPath: 'shared/voice.md', includedFrom: 'writer/system.md' },
    ]);
    expect(diagnostics.suppliedVariables).toEqual(['topic']);
    expect(diagnostics.referencedVariables).toEqual(['topic']);
    expect(diagnostics.missingVariables).toEqual([]);
    expect(diagnostics.unusedVariables).toEqual([]);
    expect(diagnostics.issues).toEqual([]);
  });

  it('returns issues instead of throwing when the prompt is invalid', async () => {
    const registry = createRegistry({
      'writer/system.md': 'System.',
      'writer/user.md': 'Needs {{missing}}.',
    });

    const diagnostics = await registry.diagnose('writer', { extra: 'unused' });

    expect(diagnostics.valid).toBe(false);
    expect(diagnostics.missingVariables).toEqual(['missing']);
    expect(diagnostics.unusedVariables).toEqual(['extra']);
    expect(diagnostics.issues.length).toBeGreaterThan(0);
  });

  it('reports cache status reflecting which files have actually been read', async () => {
    const registry = createRegistry({
      'writer/system.md': '{{> shared/voice.md}}',
      'writer/user.md': 'Task.',
      'shared/voice.md': 'Voice fragment.',
    });

    const diagnostics = await registry.diagnose('writer', {});

    expect(diagnostics.cacheStatus).toEqual(
      expect.arrayContaining([
        { logicalPath: 'writer/system.md', cached: true },
        { logicalPath: 'writer/user.md', cached: true },
        { logicalPath: 'shared/voice.md', cached: true },
      ]),
    );
  });

  it('estimates approximate, model-independent token counts per section and total', async () => {
    const registry = createRegistry({
      'writer/system.md': 'a'.repeat(8),
      'writer/user.md': 'a'.repeat(12),
    });

    const diagnostics = await registry.diagnose('writer', {});

    expect(diagnostics.estimatedTokens.system).toBe(2);
    expect(diagnostics.estimatedTokens.user).toBe(3);
    expect(diagnostics.estimatedTokens.total).toBe(5);
  });

  it('never makes a network or provider call for an invalid prompt', async () => {
    const registry = createRegistry({});

    const diagnostics = await registry.diagnose('writer', {});

    expect(diagnostics.valid).toBe(false);
    expect(diagnostics.system).toBeUndefined();
    expect(diagnostics.user).toBeUndefined();
  });
});

describe('registry key vocabulary', () => {
  it('exposes no duplicate registry keys', () => {
    const seen = new Set<string>();
    for (const key of PROMPT_KEYS) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('createPromptRegistry', () => {
  it('returns a registry implementing both the module-facing and diagnostics surfaces', () => {
    const registry = createPromptRegistry();

    expect(typeof registry.get).toBe('function');
    expect(typeof registry.diagnose).toBe('function');
    expect(typeof registry.invalidateCache).toBe('function');
  });
});

describe('static import-graph guard', () => {
  it('never imports a provider SDK, LLMProvider, or ImageProvider', async () => {
    const registrySource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../registry.ts', import.meta.url), 'utf8'),
    );

    expect(registrySource).not.toMatch(/providers\/(llm|image)/);
    expect(registrySource).not.toMatch(/LLMProvider|ImageProvider|providerFactory/);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
