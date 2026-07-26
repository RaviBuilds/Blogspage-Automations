/** Tests for the provider-agnostic Publisher module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type Brief,
  type DraftSection,
  type PipelineState,
  type PlanningSection,
  type ResearchSection,
  type ReviewSection,
  type SeoSection,
} from '@/core/state.js';

import {
  buildPublishRequest,
  publisherModuleMetadata,
  type PublisherModuleServices,
  createPublisherModule,
  createPublisherModuleBinding,
  PublishArtifactSchema,
  normalizePublishRequest,
  registerPublisherModule,
  toPublishSection,
  type PublishRequest,
  type PublishArtifact,
  type PublishSection,
} from '../publisherModule.js';

const BRIEF: Brief = {
  topic: 'AI and Machine Learning in 2024',
  targetAudience: 'Technology professionals',
  keywordHints: ['AI', 'machine learning', 'technology'],
  sheetRowId: 'row-123',
} as const;

const RESEARCH: ResearchSection = {
  keyFacts: ['AI adoption is increasing', 'Machine learning is transforming industries'],
  suggestedAngle: 'Technical deep-dive',
  candidateStatistics: [{ claim: '75% adoption rate', informalSource: 'Industry Report' }],
} as const;

const PLANNING: PlanningSection = {
  titleCandidates: ['AI and Machine Learning Guide 2024'],
  outline: [
    {
      heading: 'Introduction',
      level: 2,
      talkingPoints: ['Overview', 'Key trends'],
    },
    {
      heading: 'Core Concepts',
      level: 3,
      talkingPoints: ['Definition', 'Applications'],
    },
  ],
  targetWordCount: 1500,
  angle: 'Technical deep-dive',
} as const;

const SEO: SeoSection = {
  focusKeyword: 'AI machine learning',
  seoKeywords: ['AI', 'machine learning', 'technology', 'innovation'],
  seoTitleDraft: 'AI and Machine Learning Guide 2024',
  metaDescriptionDraft: 'Complete guide to AI and machine learning trends in 2024.',
  internalLinkTargets: [
    {
      candidateSlug: 'machine-learning-basics',
      candidateTitle: 'Machine Learning Basics',
      relevance: 'high',
    },
    {
      candidateSlug: 'ai-implementation',
      candidateTitle: 'AI Implementation Guide',
      relevance: 'medium',
    },
  ],
} as const;

const DRAFT: DraftSection = {
  current: {
    markdown: `# AI and Machine Learning in 2024

[[image: Hero image showing AI technology]]

This is the introduction paragraph with a [[link: machine learning guide]].

## Introduction

Content about AI and machine learning trends.

[[image: Diagram illustrating neural networks]]

More content here about the future of AI.`,
    wordCount: 1200,
    linkMarkers: [{ markerId: 'link-1', anchorTextHint: 'machine learning guide' }],
    imageMarkers: [
      { markerId: 'image-1', role: 'hero', descriptionHint: 'Hero image showing AI technology' },
      {
        markerId: 'image-2',
        role: 'inline',
        descriptionHint: 'Diagram illustrating neural networks',
      },
    ],
  },
  history: [],
} as const;

const REVIEW: ReviewSection = {
  technical: {
    passed: true,
    issues: [],
  },
  seo: {
    passed: true,
    issues: [],
  },
  loop: {
    iteration: 0,
  },
} as const;

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(): PublisherModuleServices {
  return {};
}

function createState(): PipelineState {
  const base = createInitialState();
  return {
    ...base,
    brief: BRIEF,
    research: RESEARCH,
    planning: PLANNING,
    seo: SEO,
    draft: DRAFT,
    review: REVIEW,
  };
}

describe('publisherModule', () => {
  describe('publisherModuleMetadata', () => {
    it('has the correct module key', () => {
      expect(publisherModuleMetadata.key).toBe('publish');
    });

    it('has a non-empty display name', () => {
      expect(publisherModuleMetadata.displayName.trim().length).toBeGreaterThan(0);
    });

    it('has a non-empty description', () => {
      expect(publisherModuleMetadata.description.trim().length).toBeGreaterThan(0);
    });

    it('declares correct dependencies', () => {
      expect(publisherModuleMetadata.dependencies).toEqual(
        expect.arrayContaining([
          'research',
          'planner',
          'seo-planner',
          'writer',
          'reviewer-technical',
          'humanizer',
          'content-assets-planner',
        ]),
      );
    });

    it('declares required capabilities', () => {
      expect(publisherModuleMetadata.capabilities.requires).toEqual(
        expect.arrayContaining([
          'research.structured-output',
          'planner.content-plan',
          'seo.strategy',
          'writer.draft',
          'reviewer.technical-review',
          'humanizer.humanized-draft',
          'content-assets-planner.asset-blueprint',
        ]),
      );
    });

    it('declares provided capabilities', () => {
      expect(publisherModuleMetadata.capabilities.provides).toEqual(
        expect.arrayContaining(['publisher.publish-artifact', 'publisher.state-projection']),
      );
    });
  });

  describe('buildPublishRequest', () => {
    it('builds a valid request from complete pipeline state', () => {
      const state = createState();
      const request = buildPublishRequest(state);

      expect(request.brief).toEqual(BRIEF);
      expect(request.research).toEqual(RESEARCH);
      expect(request.planning).toEqual(PLANNING);
      expect(request.seo).toEqual(SEO);
      expect(request.draft).toEqual(DRAFT);
      expect(request.review).toEqual(REVIEW);
    });

    it('throws ValidationError when brief is missing', () => {
      const state = createState();
      const incompleteState = { ...state, brief: undefined } as PipelineState;

      expect(() => buildPublishRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when research is missing', () => {
      const state = createState();
      const incompleteState = { ...state, research: undefined } as PipelineState;

      expect(() => buildPublishRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when planning is missing', () => {
      const state = createState();
      const incompleteState = { ...state, planning: undefined } as PipelineState;

      expect(() => buildPublishRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when seo is missing', () => {
      const state = createState();
      const incompleteState = { ...state, seo: undefined } as PipelineState;

      expect(() => buildPublishRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when draft is missing', () => {
      const state = createState();
      const incompleteState = { ...state, draft: undefined } as PipelineState;

      expect(() => buildPublishRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when review is missing', () => {
      const state = createState();
      const incompleteState = { ...state, review: undefined } as PipelineState;

      expect(() => buildPublishRequest(incompleteState)).toThrow(ValidationError);
    });
  });

  describe('normalizePublishRequest', () => {
    it('returns a frozen request object', () => {
      const request: PublishRequest = {
        brief: BRIEF,
        research: RESEARCH,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        review: REVIEW,
      };
      const normalized = normalizePublishRequest(request);

      expect(Object.isFrozen(normalized)).toBe(true);
    });

    it('preserves all input fields', () => {
      const request: PublishRequest = {
        brief: BRIEF,
        research: RESEARCH,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        review: REVIEW,
      };
      const normalized = normalizePublishRequest(request);

      expect(normalized.brief).toEqual(request.brief);
      expect(normalized.research).toEqual(request.research);
      expect(normalized.planning).toEqual(request.planning);
      expect(normalized.seo).toEqual(request.seo);
      expect(normalized.draft).toEqual(request.draft);
      expect(normalized.review).toEqual(request.review);
    });
  });

  describe('toPublishSection', () => {
    it('projects publish artifact to minimal PublishSection contract', () => {
      const artifact: PublishArtifact = {
        content: {
          markdown: 'Test content',
          html: '<p>Test content</p>',
          plainText: 'Test content',
        },
        metadata: {
          title: 'Test Title',
          slug: 'test-title',
          description: 'Test description',
          tags: ['tag1'],
          categories: ['General'],
          canonicalUrlPlaceholder: '{{CANONICAL_URL}}',
          publishDatePlaceholder: '{{PUBLISH_DATE}}',
          readingTimeMinutes: 5,
          readingTimeIsoDuration: 'PT5M',
          wordCount: 1000,
        },
        seo: {
          metaTitle: 'Test Meta Title',
          metaDescription: 'Test meta description',
          openGraph: {
            ogTitle: 'OG Title',
            ogDescription: 'OG description',
            ogType: 'article',
            ogImageAlt: 'Test image alt',
          },
          twitter: {
            twitterCard: 'summary_large_image',
            twitterTitle: 'Twitter Title',
            twitterDescription: 'Twitter description',
            twitterImageAlt: 'Twitter image alt',
          },
          jsonLd: '{}',
        },
        assets: {
          featuredImage: {
            id: 'image-1',
            role: 'hero',
            altText: 'Test alt text',
          },
          imageManifest: [
            {
              id: 'image-1',
              role: 'hero',
              altText: 'Test alt text',
            },
          ],
          altTextManifest: [
            {
              imageId: 'image-1',
              altText: 'Test alt text',
            },
          ],
          captionManifest: [],
        },
        structuredContent: {
          faqSchema: [],
          ctaBlocks: [],
          relatedArticles: [],
          internalLinks: [],
        },
        validation: {
          summary: 'valid',
          missingAssets: [],
          warnings: [],
          errors: [],
        },
        checksums: {
          contentHash: 'abc123',
          artifactVersion: 1,
          pipelineVersion: '7H',
          buildTimestamp: '2026-07-25T10:00:00.000Z',
        },
      };

      const section = toPublishSection(artifact);

      expect(section.isValid).toBe(true);
      expect(section.warningCount).toBe(0);
      expect(section.errorCount).toBe(0);
      expect(section.contentHash).toBe('abc123');
      expect(section.artifactVersion).toBe(1);
    });
  });

  describe('createPublisherModule', () => {
    it('creates a module with correct metadata', () => {
      const module = createPublisherModule();

      expect(module.metadata).toStrictEqual(publisherModuleMetadata);
    });

    it('creates a module with an execute function', () => {
      const module = createPublisherModule();

      expect(typeof module.execute).toBe('function');
    });
  });

  describe('registerPublisherModule', () => {
    it('registers the module in the registry', () => {
      const registry = createModuleRegistry<PublisherModuleServices>();

      registerPublisherModule(registry);

      expect(registry.has('publish')).toBe(true);
    });

    it('returns the registry for chaining', () => {
      const registry = createModuleRegistry<PublisherModuleServices>();
      const returned = registerPublisherModule(registry);

      expect(returned).toBe(registry);
    });

    it('throws when registering the same module twice', () => {
      const registry = createModuleRegistry<PublisherModuleServices>();

      registerPublisherModule(registry);

      expect(() => registerPublisherModule(registry)).toThrow(RangeError);
    });
  });

  describe('createPublisherModuleBinding', () => {
    it('creates a binding with the correct key', () => {
      const binding = createPublisherModuleBinding();

      expect(binding.key).toBe('publish');
    });

    it('creates input from pipeline state', () => {
      const binding = createPublisherModuleBinding();
      const state = createState();

      const input = binding.createInput(state, {} as never);

      expect(input).toBeDefined();
      expect((input as PublishRequest).research).toBeDefined();
    });
  });
});

describe('Publisher execution through ModuleRunner', () => {
  it('executes successfully and returns the publish artifact', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.content.markdown).toBe(DRAFT.current.markdown);
    expect(result.output.metadata.title).toBe(PLANNING.titleCandidates[0]);
    expect(result.output.seo.metaTitle).toBe(SEO.seoTitleDraft);
  });

  it('produces valid HTML from markdown', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.content.html).toContain('<h2>');
    expect(result.output.content.html).toContain('<p>');
  });

  it('produces valid plain text from markdown', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.content.plainText).not.toContain('#');
    expect(result.output.content.plainText).not.toContain('[[');
  });

  it('calculates reading time correctly', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.metadata.readingTimeMinutes).toBeGreaterThanOrEqual(1);
    expect(result.output.metadata.readingTimeIsoDuration).toMatch(/^PT\d+M$/);
  });

  it('generates correct slug from topic', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.metadata.slug).toBe('ai-and-machine-learning-in-2024');
  });

  it('builds correct SEO metadata', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.seo.metaTitle).toBe(SEO.seoTitleDraft);
    expect(result.output.seo.metaDescription).toBe(SEO.metaDescriptionDraft);
    expect(result.output.seo.openGraph.ogTitle).toBe(SEO.seoTitleDraft);
    expect(result.output.seo.twitter.twitterCard).toBe('summary_large_image');
  });

  it('builds correct assets manifest', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.assets.featuredImage.id).toBe('image-1');
    expect(result.output.assets.featuredImage.role).toBe('hero');
    expect(result.output.assets.imageManifest).toHaveLength(2);
  });

  it('builds correct structured content', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.structuredContent.internalLinks).toHaveLength(1);
    expect(result.output.structuredContent.ctaBlocks).toHaveLength(1);
  });

  it('builds correct validation artifact', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.validation.summary).toBe('valid');
    expect(result.output.validation.errors).toHaveLength(0);
  });

  it('builds correct checksums', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.checksums.contentHash).toHaveLength(64);
    expect(result.output.checksums.artifactVersion).toBe(1);
    expect(result.output.checksums.pipelineVersion).toBe('7H');
  });

  it('does NOT record cost events (deterministic module)', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.state.metrics.costEvents).toHaveLength(0);
  });

  it('throws ValidationError when draft has no hero image', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);

    const invalidDraft: DraftSection = {
      current: {
        markdown: 'Test content',
        wordCount: 100,
        linkMarkers: [],
        imageMarkers: [{ markerId: 'image-1', role: 'inline', descriptionHint: 'Inline image' }],
      },
      history: [],
    };

    const state = createState();
    const invalidState = { ...state, draft: invalidDraft } as PipelineState;

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildPublishRequest(invalidState),
      invalidState,
      services,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toBeInstanceOf(ValidationError);
  });
});

describe('Publisher registry and orchestrator compatibility', () => {
  it('declares frozen dependencies and capabilities and registers independently', () => {
    const registry = createModuleRegistry<PublisherModuleServices>();
    registerPublisherModule(registry);

    const module = registry.require('publish');
    expect(module.metadata.dependencies).toEqual([
      'research',
      'planner',
      'seo-planner',
      'writer',
      'reviewer-technical',
      'humanizer',
      'content-assets-planner',
    ]);
    expect(module.metadata.capabilities).toEqual({
      requires: [
        'research.structured-output',
        'planner.content-plan',
        'seo.strategy',
        'writer.draft',
        'reviewer.technical-review',
        'humanizer.humanized-draft',
        'content-assets-planner.asset-blueprint',
      ],
      provides: ['publisher.publish-artifact', 'publisher.state-projection'],
    });
  });

  it('registers and executes through the orchestrator binding', async () => {
    const services = createServices();
    const module = createPublisherModule();
    const registry = createModuleRegistry<PublisherModuleServices>().register(module);
    const state = createState();
    const binding = createPublisherModuleBinding();
    const context = {} as never;

    const input = binding.createInput(state, context);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as PublishRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, context);
    expect(
      (newState as PipelineState & { publish: PublishSection }).publish.contentHash,
    ).toHaveLength(64);
  });
});

describe('PublishArtifactSchema', () => {
  it('validates a correct artifact', () => {
    const artifact: PublishArtifact = {
      content: {
        markdown: 'Test',
        html: '<p>Test</p>',
        plainText: 'Test',
      },
      metadata: {
        title: 'Test',
        slug: 'test',
        description: 'Test description',
        tags: [],
        categories: ['General'],
        canonicalUrlPlaceholder: '{{CANONICAL_URL}}',
        publishDatePlaceholder: '{{PUBLISH_DATE}}',
        readingTimeMinutes: 1,
        readingTimeIsoDuration: 'PT1M',
        wordCount: 100,
      },
      seo: {
        metaTitle: 'Test',
        metaDescription: 'Test',
        openGraph: {
          ogTitle: 'Test',
          ogDescription: 'Test',
          ogType: 'article',
          ogImageAlt: 'Test',
        },
        twitter: {
          twitterCard: 'summary_large_image',
          twitterTitle: 'Test',
          twitterDescription: 'Test',
          twitterImageAlt: 'Test',
        },
        jsonLd: '{}',
      },
      assets: {
        featuredImage: {
          id: 'test-id',
          role: 'hero',
          altText: 'Test alt',
        },
        imageManifest: [
          {
            id: 'test-id',
            role: 'hero',
            altText: 'Test alt',
          },
        ],
        altTextManifest: [],
        captionManifest: [],
      },
      structuredContent: {
        faqSchema: [],
        ctaBlocks: [],
        relatedArticles: [],
        internalLinks: [],
      },
      validation: {
        summary: 'valid',
        missingAssets: [],
        warnings: [],
        errors: [],
      },
      checksums: {
        contentHash: 'abc123',
        artifactVersion: 1,
        pipelineVersion: '7H',
        buildTimestamp: '2026-07-25T10:00:00.000Z',
      },
    };

    const parsed = PublishArtifactSchema.safeParse(artifact);

    expect(parsed.success).toBe(true);
  });

  it('rejects artifact with missing required fields', () => {
    const incompleteArtifact = {
      content: {
        markdown: 'Test',
        html: '<p>Test</p>',
        plainText: 'Test',
      },
    };

    const parsed = PublishArtifactSchema.safeParse(incompleteArtifact);

    expect(parsed.success).toBe(false);
  });
});
