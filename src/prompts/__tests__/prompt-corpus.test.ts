import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FilePromptRegistry, PROMPT_KEYS } from '@/prompts/registry.js';

const PROMPTS_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The exact, documented per-key file inventory (13-prompt-management-system.md). */
const DOCUMENTED_ROLES: Readonly<Record<string, readonly string[]>> = {
  research: ['system', 'user', 'examples'],
  planner: ['system', 'user', 'examples'],
  'seo-planner': ['system', 'user', 'examples'],
  writer: ['system', 'user', 'validation', 'examples'],
  'reviewer-technical': ['system', 'user', 'validation'],
  'reviewer-seo': ['system', 'user', 'validation'],
  humanizer: ['system', 'user'],
  'content-assets-planner': ['system', 'user'],
  qa: ['system', 'user', 'validation'],
  improver: ['system', 'user', 'repair'],
  'image-planner': ['system', 'user'],
  'image-validator': ['system', 'user', 'validation'],
  'internal-links': ['system', 'user'],
  'faq-generator': ['system', 'user'],
};

const SHARED_FRAGMENTS = ['brand-voice.md', 'json-schema-contract.md', 'output-format-json.md'];

const PLACEHOLDER_MARKERS = ['TODO', 'TBD', 'FIXME', 'lorem ipsum'];

function createRegistry(): FilePromptRegistry {
  return new FilePromptRegistry({ resolveVersion: () => Promise.resolve('test-version') });
}

describe('prompt corpus inventory', () => {
  it('matches the documented registry-key vocabulary exactly', () => {
    expect(new Set(PROMPT_KEYS)).toEqual(new Set(Object.keys(DOCUMENTED_ROLES)));
  });

  it.each(Object.entries(DOCUMENTED_ROLES))(
    '"%s" has exactly its documented role files, no more, no fewer',
    async (key, expectedRoles) => {
      const entries = await readdir(`${PROMPTS_ROOT}${key}`);
      const actualRoles = entries
        .filter((entry) => entry.endsWith('.md'))
        .map((entry) => entry.replace(/\.md$/, ''))
        .sort((a, b) => a.localeCompare(b));

      expect(actualRoles).toEqual([...expectedRoles].sort((a, b) => a.localeCompare(b)));
    },
  );

  it('has exactly the three documented shared fragments', async () => {
    const entries = await readdir(`${PROMPTS_ROOT}shared`);
    expect(entries.sort((a, b) => a.localeCompare(b))).toEqual(
      [...SHARED_FRAGMENTS].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe('prompt corpus resolution (real files, no fakes)', () => {
  it.each(PROMPT_KEYS)(
    '"%s" resolves cleanly once every referenced variable is supplied',
    async (key) => {
      const registry = createRegistry();

      const discovery = await registry.diagnose(key, {});
      const vars = Object.fromEntries(
        discovery.referencedVariables.map((name) => [name, `test-value-for-${name}`]),
      );

      const promptSet = await registry.get(key, vars);

      for (const section of [
        promptSet.system,
        promptSet.user,
        promptSet.examples,
        promptSet.validation,
        promptSet.repair,
      ]) {
        if (section !== undefined) {
          expect(section).not.toMatch(/\{\{[^}]*\}\}/);
        }
      }
    },
  );

  it.each(PROMPT_KEYS)(
    '"%s" diagnostics report zero issues once every variable is supplied',
    async (key) => {
      const registry = createRegistry();

      const discovery = await registry.diagnose(key, {});
      const vars = Object.fromEntries(
        discovery.referencedVariables.map((name) => [name, `test-value-for-${name}`]),
      );
      const diagnostics = await registry.diagnose(key, vars);

      expect(diagnostics.valid).toBe(true);
      expect(diagnostics.issues).toEqual([]);
    },
  );
});

describe('prompt corpus content hygiene', () => {
  const allLogicalPaths = [
    ...SHARED_FRAGMENTS.map((file) => `shared/${file}`),
    ...Object.entries(DOCUMENTED_ROLES).flatMap(([key, roles]) =>
      roles.map((role) => `${key}/${role}.md`),
    ),
  ];

  it.each(allLogicalPaths)('"%s" contains no TODO/TBD/placeholder markers', async (logicalPath) => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(`${PROMPTS_ROOT}${logicalPath}`, 'utf8');

    for (const marker of PLACEHOLDER_MARKERS) {
      expect(content.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });

  it.each(allLogicalPaths)('"%s" is non-empty', async (logicalPath) => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(`${PROMPTS_ROOT}${logicalPath}`, 'utf8');

    expect(content.trim().length).toBeGreaterThan(0);
  });
});
