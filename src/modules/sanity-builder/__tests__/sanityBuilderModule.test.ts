/** Tests for the Sanity Document Builder module. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type Brief,
  type DraftSection,
  type ImagesSection,
  type PlanningSection,
  type PipelineState,
  type SeoSection,
} from '@/core/state.js';

import {
  buildSanityBuilderRequest,
  buildSanityDocument,
  createSanityBuilderModule,
  createSanityBuilderModuleBinding,
  normalizeExcerpt,
  sanityBuilderModuleMetadata,
  type SanityBuilderModuleServices,
  type SanityBuilderRequest,
} from '../sanityBuilderModule.js';

const BRIEF: Brief = { topic: 'How direct booking beats OTAs', sheetRowId: 'row-1' };

const PLANNING: PlanningSection = {
  titleCandidates: ['Why direct booking beats OTAs for independent hotels'],
  outline: [{ heading: 'Intro', level: 2, talkingPoints: ['Margin loss'] }],
  targetWordCount: 800,
  angle: 'Direct booking reclaims hotel margin.',
};

const SEO: SeoSection = {
  focusKeyword: 'direct booking hotels',
  seoKeywords: ['direct booking', 'hotels'],
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

const CONTENT = [{ _type: 'block', _key: 'b1', style: 'normal', children: [], markDefs: [] }];

const HERO_UPLOAD: ImagesSection = {
  plan: { images: [] },
  uploaded: [
    {
      imageId: 'hero',
      role: 'hero',
      assetId: 'image-hash-hero-1200x630-png',
      altText: 'Hotel lobby room matrix',
    },
  ],
};

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(): SanityBuilderModuleServices {
  return { llmProvider: undefined as never, promptRegistry: undefined as never };
}

function createState(): PipelineState {
  return {
    ...createInitialState(),
    brief: BRIEF,
    planning: PLANNING,
    seo: SEO,
    draft: DRAFT,
    images: HERO_UPLOAD,
    sanity: { portableText: CONTENT },
  };
}

describe('sanityBuilderModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(sanityBuilderModuleMetadata.key).toBe('sanity-builder');
    expect(sanityBuilderModuleMetadata.dependencies).toEqual([
      'internal-links',
      'portable-text',
      'faq-generator',
      'structured-data-check',
      'image-upload',
    ]);
  });
});

describe('buildSanityDocument', () => {
  it('assembles a complete post document with seeded refs and hero image', () => {
    const document = buildSanityDocument({
      brief: BRIEF,
      planning: PLANNING,
      seo: SEO,
      draft: DRAFT,
      images: HERO_UPLOAD,
      portableText: CONTENT,
      faq: [],
    });

    expect(document._type).toBe('post');
    expect(document.title).toBe(PLANNING.titleCandidates[0]);
    expect(document.slug.current).toBe('why-direct-booking-beats-otas-for-independent-hotels');
    expect(document.author._ref).toBe('author-ravi');
    expect(document.categories).toHaveLength(1);
    expect(document.categories[0]?._key).toBe('cat1');
    expect(document.excerpt.length).toBeGreaterThanOrEqual(50);
    expect(document.excerpt.length).toBeLessThanOrEqual(200);
    expect(document.mainImage?.asset._ref).toBe('image-hash-hero-1200x630-png');
    expect(document.featured).toBe(false);
    expect(document.evergreen).toBe(false);
    expect(document.focusKeyword).toBe('direct booking hotels');
  });

  it('omits mainImage when no hero upload exists', () => {
    const document = buildSanityDocument({
      brief: BRIEF,
      planning: PLANNING,
      seo: SEO,
      draft: DRAFT,
      portableText: CONTENT,
      faq: [],
    });

    expect(document.mainImage).toBeUndefined();
  });

  it('throws when portable content is empty', () => {
    expect(() =>
      buildSanityDocument({
        brief: BRIEF,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        portableText: [],
        faq: [],
      }),
    ).toThrow(ValidationError);
  });
});

describe('normalizeExcerpt', () => {
  it('keeps a valid excerpt and pads/truncates to the 50-200 range', () => {
    const longEnough = normalizeExcerpt(
      'This is a complete, descriptive meta description used as the post excerpt for search engines everywhere.',
      BRIEF.topic,
    );
    expect(longEnough.length).toBeGreaterThanOrEqual(50);
    expect(longEnough.length).toBeLessThanOrEqual(200);

    const padded = normalizeExcerpt('Too short', BRIEF.topic);
    expect(padded.length).toBeGreaterThanOrEqual(50);

    const huge = 'x'.repeat(500);
    expect(normalizeExcerpt(huge, BRIEF.topic).length).toBeLessThanOrEqual(200);
  });
});

describe('sanityBuilderModule via the orchestrator binding', () => {
  it('writes sanity.document through the module runner', async () => {
    const services = createServices();
    const module = createSanityBuilderModule();
    const registry = createModuleRegistry<SanityBuilderModuleServices>().register(module);
    const state = createState();
    const binding = createSanityBuilderModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as SanityBuilderRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.sanity?.document?.title).toBe(PLANNING.titleCandidates[0]);
  });

  it('rejects a missing brief', () => {
    expect(() => buildSanityBuilderRequest(createInitialState())).toThrow(ValidationError);
  });
});
