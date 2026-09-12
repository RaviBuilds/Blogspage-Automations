/** Tests for the Internal Link Generator module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type DraftSection,
  type PipelineState,
  type SeoSection,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptSet } from '@/prompts/registry.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the internal link resolver.',
  user: 'Resolve the links.',
  promptVersion: 'abc1234',
});

import {
  buildInternalLinksRequest,
  createInternalLinksModule,
  createInternalLinksModuleBinding,
  internalLinksModuleMetadata,
  resolveInternalLinks,
  type InternalLinksModuleServices,
  type InternalLinksRequest,
  type PostLookup,
} from '../internalLinksModule.js';

const SEO: SeoSection = {
  focusKeyword: 'direct booking hotels',
  seoKeywords: ['direct booking', 'hotels', 'OTA'],
  seoTitleDraft: 'Direct booking beats OTAs for independent hotels',
  metaDescriptionDraft:
    'OTA platforms quietly drain independent hotel margin. Here is how a direct booking engine reclaims revenue and control.',
  internalLinkTargets: [
    {
      candidateSlug: 'why-direct-booking',
      candidateTitle: 'Why direct booking beats OTAs',
      relevance: 'high',
    },
    {
      candidateSlug: 'hotel-revenue-tools',
      candidateTitle: 'Hotel revenue tools for 2026',
      relevance: 'medium',
    },
  ],
};

const DRAFT: DraftSection = {
  current: {
    markdown: 'See [[link: link-1]] and [[link: link-2]] in this article.',
    wordCount: 12,
    linkMarkers: [
      { markerId: 'link-1', anchorTextHint: 'Why direct booking beats OTAs' },
      { markerId: 'link-2', anchorTextHint: 'hotel-revenue-tools' },
    ],
    imageMarkers: [],
  },
  history: [],
};

const LOOKUP: PostLookup = {
  findPostIdBySlug: (slug: string) =>
    Promise.resolve(
      slug === 'why-direct-booking' || slug === 'hotel-revenue-tools' ? `post-${slug}` : null,
    ),
};

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(options: { postLookup?: PostLookup } = {}): InternalLinksModuleServices {
  return {
    llmProvider: new FakeLLMProvider(),
    promptRegistry: {
      get: () => Promise.resolve(MOCK_PROMPT_SET),
    },
    ...(options.postLookup !== undefined ? { postLookup: options.postLookup } : {}),
  };
}

function createState(): PipelineState {
  return { ...createInitialState(), seo: SEO, draft: DRAFT };
}

describe('internalLinksModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(internalLinksModuleMetadata.key).toBe('internal-links');
    expect(internalLinksModuleMetadata.dependencies).toEqual([
      'seo-planner',
      'writer',
      'humanizer',
    ]);
  });
});

describe('resolveInternalLinks', () => {
  it('resolves markers by title and slug against the post lookup', async () => {
    const resolved = await resolveInternalLinks({ seo: SEO, draft: DRAFT }, LOOKUP);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({
      markerId: 'link-1',
      targetPostId: 'post-why-direct-booking',
      targetSlug: 'why-direct-booking',
      anchorText: 'Why direct booking beats OTAs',
    });
    expect(resolved[1]).toMatchObject({
      markerId: 'link-2',
      targetSlug: 'hotel-revenue-tools',
    });
  });

  it('skips markers whose target post does not exist', async () => {
    const resolved = await resolveInternalLinks(
      { seo: SEO, draft: DRAFT },
      { findPostIdBySlug: () => Promise.resolve(null) },
    );
    expect(resolved).toEqual([]);
  });

  it('skips markers with no matching seo target', async () => {
    const resolved = await resolveInternalLinks(
      {
        seo: SEO,
        draft: {
          current: {
            markdown: 'x',
            wordCount: 1,
            linkMarkers: [{ markerId: 'nope', anchorTextHint: 'nothing matches' }],
            imageMarkers: [],
          },
          history: [],
        },
      },
      LOOKUP,
    );
    expect(resolved).toEqual([]);
  });
});

describe('internalLinksModule via the orchestrator binding', () => {
  it('writes sanity.resolvedLinks through the module runner', async () => {
    const services = createServices({ postLookup: LOOKUP });
    const module = createInternalLinksModule();
    const registry = createModuleRegistry<InternalLinksModuleServices>().register(module);
    const state = createState();
    const binding = createInternalLinksModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as InternalLinksRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.sanity?.resolvedLinks).toHaveLength(2);
  });

  it('returns an empty resolution set when no post lookup is injected', async () => {
    const services = createServices({});
    const module = createInternalLinksModule();
    const registry = createModuleRegistry<InternalLinksModuleServices>().register(module);
    const state = createState();
    const binding = createInternalLinksModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as InternalLinksRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.sanity?.resolvedLinks).toEqual([]);
  });

  it('rejects a missing seo section', () => {
    expect(() => buildInternalLinksRequest(createInitialState())).toThrow(ValidationError);
  });
});
