import { describe, expect, it } from 'vitest';

import { buildOverrideCandidates, resolvePromptSet, type PromptFileSource } from '@/lib/prompts.js';

/** An in-memory PromptFileSource so these tests never touch the filesystem. */
class FakePromptFileSource implements PromptFileSource {
  public constructor(private readonly files: Readonly<Record<string, string>>) {}

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

function createLoader(source: PromptFileSource): (logicalPath: string) => Promise<string> {
  return (logicalPath) => source.readFile(logicalPath);
}

describe('resolvePromptSet', () => {
  it('resolves a minimal valid prompt set with only required roles', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'You are the writer.',
      'writer/user.md': 'Write about {{topic}}.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      { topic: 'direct booking' },
      {},
      source,
      createLoader(source),
    );

    expect(resolution.valid).toBe(true);
    expect(resolution.issues).toEqual([]);
    expect(resolution.system).toBe('You are the writer.');
    expect(resolution.user).toBe('Write about direct booking.');
    expect(resolution.examples).toBeUndefined();
    expect(resolution.validation).toBeUndefined();
    expect(resolution.repair).toBeUndefined();
  });

  it('fails closed when a required file is missing', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'You are the writer.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    const missingFileIssue = resolution.issues.find((issue) => issue.kind === 'missing-file');
    expect(missingFileIssue?.message).toContain('"user.md"');
  });

  it('expands a shared partial before interpolation', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': '{{> shared/brand-voice.md}}\n\nWrite for {{audience}}.',
      'writer/user.md': 'Go.',
      'shared/brand-voice.md': 'Speak with Blogspage brand voice.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      { audience: 'hotel owners' },
      {},
      source,
      createLoader(source),
    );

    expect(resolution.valid).toBe(true);
    expect(resolution.system).toBe('Speak with Blogspage brand voice.\n\nWrite for hotel owners.');
    expect(resolution.includedFragments).toEqual([
      { logicalPath: 'shared/brand-voice.md', includedFrom: 'writer/system.md' },
    ]);
  });

  it('expands nested partials transitively', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': '{{> shared/outer.md}}',
      'writer/user.md': 'Go.',
      'shared/outer.md': 'Outer start. {{> shared/inner.md}} Outer end.',
      'shared/inner.md': 'Inner content.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(true);
    expect(resolution.system).toBe('Outer start. Inner content. Outer end.');
    expect(resolution.includedFragments).toEqual([
      { logicalPath: 'shared/outer.md', includedFrom: 'writer/system.md' },
      { logicalPath: 'shared/inner.md', includedFrom: 'shared/outer.md' },
    ]);
  });

  it('reports a missing shared partial as a validation issue, never throwing', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': '{{> shared/does-not-exist.md}}',
      'writer/user.md': 'Go.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    const missingPartialIssue = resolution.issues.find((issue) => issue.kind === 'missing-partial');
    expect(missingPartialIssue?.message).toContain('shared/does-not-exist.md');
  });

  it('rejects a partial path attempting traversal outside the prompt root', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': '{{> ../../etc/passwd}}',
      'writer/user.md': 'Go.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    expect(resolution.issues).toContainEqual(expect.objectContaining({ kind: 'missing-partial' }));
  });

  it('detects a direct circular partial reference without hanging', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': '{{> shared/a.md}}',
      'writer/user.md': 'Go.',
      'shared/a.md': 'A includes {{> shared/a.md}}.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    const circularIssue = resolution.issues.find((issue) => issue.kind === 'circular-partial');
    expect(circularIssue?.message).toContain('shared/a.md -> shared/a.md');
  });

  it('detects a multi-hop circular partial reference without hanging', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': '{{> shared/a.md}}',
      'writer/user.md': 'Go.',
      'shared/a.md': '{{> shared/b.md}}',
      'shared/b.md': '{{> shared/a.md}}',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    expect(resolution.issues).toContainEqual(expect.objectContaining({ kind: 'circular-partial' }));
  });

  it('reports every unresolved variable together, not just the first one', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System needs {{alpha}}.',
      'writer/user.md': 'User needs {{beta}} and {{gamma}}.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    expect(resolution.missingVariables).toEqual(['alpha', 'beta', 'gamma']);
    expect(resolution.issues.filter((issue) => issue.kind === 'unresolved-variable')).toHaveLength(
      3,
    );
  });

  it('treats a supplied empty string as resolved, not missing', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Optional note: {{note}}.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      { note: '' },
      {},
      source,
      createLoader(source),
    );

    expect(resolution.valid).toBe(true);
    expect(resolution.user).toBe('Optional note: .');
    expect(resolution.missingVariables).toEqual([]);
  });

  it('reports a supplied-but-unreferenced variable as unused', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Uses {{topic}} only.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      { topic: 'hotels', unrelated: 'value' },
      {},
      source,
      createLoader(source),
    );

    expect(resolution.valid).toBe(false);
    expect(resolution.unusedVariables).toEqual(['unrelated']);
    expect(resolution.issues).toContainEqual(expect.objectContaining({ kind: 'unused-variable' }));
  });

  it('interpolates in one non-recursive pass, never re-parsing a value as a template', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Value: {{value}}',
    });

    const resolution = await resolvePromptSet(
      'writer',
      { value: '{{shouldNotExpand}}' },
      {},
      source,
      createLoader(source),
    );

    expect(resolution.user).toBe('Value: {{shouldNotExpand}}');
    // The literal text was never re-parsed, so it must not appear as a
    // separately-tracked referenced/missing variable.
    expect(resolution.referencedVariables).not.toContain('shouldNotExpand');
  });

  it('composes examples/validation/repair into user.md via their reserved placeholders', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Task.\n\n{{examples}}\n\n{{rubric}}\n\n{{repairInstructions}}',
      'writer/examples.md': 'Example content.',
      'writer/validation.md': 'Rubric content.',
      'writer/repair.md': 'Repair content.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(true);
    expect(resolution.user).toBe('Task.\n\nExample content.\n\nRubric content.\n\nRepair content.');
  });

  it('flags a role file whose placeholder is missing from user.md', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Task without a rubric reference.',
      'writer/validation.md': 'Rubric content.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    const mismatchIssues = resolution.issues.filter(
      (issue) => issue.kind === 'role-placeholder-mismatch',
    );
    expect(mismatchIssues.some((issue) => issue.message.includes('validation.md" exists'))).toBe(
      true,
    );
  });

  it('flags a user.md placeholder whose companion role file does not exist', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Task.\n\n{{rubric}}',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    const mismatchIssues = resolution.issues.filter(
      (issue) => issue.kind === 'role-placeholder-mismatch',
    );
    expect(mismatchIssues.some((issue) => issue.message.includes('does not exist'))).toBe(true);
  });

  it('flags a duplicate special placeholder in user.md', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': '{{rubric}} and again {{rubric}}',
      'writer/validation.md': 'Rubric content.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    expect(resolution.issues).toContainEqual(
      expect.objectContaining({ kind: 'duplicate-placeholder' }),
    );
  });

  it('flags a reserved placeholder that leaks into a role other than user.md', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System with a stray {{repairInstructions}} placeholder.',
      'writer/user.md': 'Task.',
    });

    const resolution = await resolvePromptSet('writer', {}, {}, source, createLoader(source));

    expect(resolution.valid).toBe(false);
    const misplacedIssue = resolution.issues.find(
      (issue) => issue.kind === 'misplaced-role-placeholder',
    );
    expect(misplacedIssue?.message).toContain('writer/system.md');
  });

  it('rejects a supplied variable that collides with a reserved placeholder name', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'System.',
      'writer/user.md': 'Task.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      { rubric: 'attempted override' },
      {},
      source,
      createLoader(source),
    );

    expect(resolution.valid).toBe(false);
    expect(resolution.issues).toContainEqual(
      expect.objectContaining({ kind: 'reserved-variable-name' }),
    );
  });

  it('resolves a per-file tenant+locale override while inheriting the base for other files', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'Base system.',
      'writer/user.md': 'Base user.',
      'overrides/acme/en/writer/system.md': 'Acme English system.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      {},
      { tenantId: 'acme', locale: 'en' },
      source,
      createLoader(source),
    );

    expect(resolution.valid).toBe(true);
    expect(resolution.system).toBe('Acme English system.');
    expect(resolution.user).toBe('Base user.');
    expect(resolution.sources).toContainEqual(
      expect.objectContaining({
        role: 'system',
        logicalPath: 'overrides/acme/en/writer/system.md',
        tier: 'tenant-locale',
      }),
    );
    expect(resolution.sources).toContainEqual(
      expect.objectContaining({ role: 'user', logicalPath: 'writer/user.md', tier: 'base' }),
    );
  });

  it('prefers a tenant-only override over a locale-only override when both exist', async () => {
    const source = new FakePromptFileSource({
      'writer/system.md': 'Base system.',
      'writer/user.md': 'Base user.',
      'overrides/acme/writer/system.md': 'Tenant-only system.',
      'overrides/en/writer/system.md': 'Locale-only system.',
    });

    const resolution = await resolvePromptSet(
      'writer',
      {},
      { tenantId: 'acme', locale: 'en' },
      source,
      createLoader(source),
    );

    expect(resolution.system).toBe('Tenant-only system.');
  });
});

describe('buildOverrideCandidates', () => {
  it('returns only the base candidate with no resolution context', () => {
    const candidates = buildOverrideCandidates('writer', 'system.md', {});

    expect(candidates).toEqual([{ logicalPath: 'writer/system.md', tier: 'base' }]);
  });

  it('orders candidates most-specific-first when tenant and locale are both present', () => {
    const candidates = buildOverrideCandidates('writer', 'system.md', {
      tenantId: 'acme',
      locale: 'en',
    });

    expect(candidates).toEqual([
      { logicalPath: 'overrides/acme/en/writer/system.md', tier: 'tenant-locale' },
      { logicalPath: 'overrides/acme/writer/system.md', tier: 'tenant' },
      { logicalPath: 'overrides/en/writer/system.md', tier: 'locale' },
      { logicalPath: 'writer/system.md', tier: 'base' },
    ]);
  });
});
