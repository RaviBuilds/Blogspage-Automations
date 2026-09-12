/** Tests for the Structured Data Check module. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type Brief,
  type DraftSection,
  type PlanningSection,
  type PipelineState,
  type SeoSection,
} from '@/core/state.js';

import {
  buildStructuredDataCheckRequest,
  createStructuredDataCheckModule,
  createStructuredDataCheckModuleBinding,
  runStructuredDataCheck,
  structuredDataCheckModuleMetadata,
  type StructuredDataCheckModuleServices,
  type StructuredDataCheckRequest,
} from '../structuredDataCheckModule.js';

const BRIEF: Brief = { topic: 'How direct booking beats OTAs', sheetRowId: 'row-1' };

const PLANNING: PlanningSection = {
  titleCandidates: ['Why direct booking beats OTAs for independent hotels'],
  outline: [{ heading: 'Intro', level: 2, talkingPoints: ['Margin loss'] }],
  targetWordCount: 800,
  angle: 'Direct booking reclaims hotel margin.',
};

const SEO: SeoSection = {
  focusKeyword: 'direct booking hotels',
  seoKeywords: ['direct booking'],
  seoTitleDraft: 'Why direct booking beats OTAs for independent hotels',
  metaDescriptionDraft:
    'OTA platforms quietly drain independent hotel margin. Here is how a direct booking engine reclaims revenue and control.',
  internalLinkTargets: [],
};

const DRAFT: DraftSection = {
  current: {
    markdown: 'Article body text.',
    wordCount: 10,
    linkMarkers: [],
    imageMarkers: [],
  },
  history: [],
};

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(): StructuredDataCheckModuleServices {
  return { llmProvider: undefined as never, promptRegistry: undefined as never };
}

function createState(withContent: boolean): PipelineState {
  return {
    ...createInitialState(),
    brief: BRIEF,
    planning: PLANNING,
    seo: SEO,
    draft: DRAFT,
    sanity: {
      portableText: withContent ? [{ _type: 'block', _key: 'b1' }] : [],
    },
  };
}

describe('structuredDataCheckModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(structuredDataCheckModuleMetadata.key).toBe('structured-data-check');
    expect(structuredDataCheckModuleMetadata.dependencies).toEqual([
      'internal-links',
      'portable-text',
      'faq-generator',
    ]);
  });
});

describe('runStructuredDataCheck', () => {
  it('reports ready when content is present', () => {
    const check = runStructuredDataCheck({
      brief: BRIEF,
      planning: PLANNING,
      seo: SEO,
      draft: DRAFT,
      portableText: [{ _type: 'block', _key: 'b1' }],
      faq: [],
    });

    expect(check.ready).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.autoFilled).toContain('publishedAt (set to now by the Sanity builder)');
  });

  it('flags missing content and out-of-range excerpt', () => {
    const check = runStructuredDataCheck({
      brief: BRIEF,
      planning: PLANNING,
      seo: {
        ...SEO,
        metaDescriptionDraft: 'Too short',
      },
      draft: DRAFT,
      portableText: [],
      faq: [],
    });

    expect(check.ready).toBe(false);
    expect(check.missing).toContain('content (portableText is empty)');
    expect(check.missing).toContain('excerpt (50-200 chars)');
  });
});

describe('structuredDataCheckModule via the orchestrator binding', () => {
  it('writes sanity.structuredDataCheck through the module runner', async () => {
    const services = createServices();
    const module = createStructuredDataCheckModule();
    const registry = createModuleRegistry<StructuredDataCheckModuleServices>().register(module);
    const state = createState(true);
    const binding = createStructuredDataCheckModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as StructuredDataCheckRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.sanity?.structuredDataCheck?.ready).toBe(true);
  });

  it('rejects a missing brief', () => {
    expect(() => buildStructuredDataCheckRequest(createInitialState())).toThrow(ValidationError);
  });
});
