/** Tests for the provider-agnostic Content Assets Planner module and its pipeline adapters. */

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
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptRegistry, PromptSet } from '@/prompts/registry.js';

import {
  buildAssetsRequest,
  contentAssetsPlannerModuleMetadata,
  type ContentAssetsPlannerModuleServices,
  createContentAssetsPlannerModule,
  createContentAssetsPlannerModuleBinding,
  AssetsResultSchema,
  normalizeAssetsRequest,
  registerContentAssetsPlannerModule,
  toAssetsSection,
  type AssetsRequest,
  type AssetsResult,
} from '../contentAssetsPlannerModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the content assets planner.',
  user: 'Plan the assets.',
  promptVersion: 'abc1234',
});

const ASSETS_RESULT: AssetsResult = {
  images: {
    featured: {
      id: 'featured-1',
      type: 'featured',
      prompt: 'A professional hero image showing technology innovation',
      altText: 'Technology innovation concept',
      aspectRatio: '16:9',
      suggestedFilename: 'featured-technology-innovation.jpg',
      caption: 'Innovation in technology',
    },
    openGraph: {
      id: 'og-1',
      type: 'opengraph',
      prompt: 'Social media optimized image for technology article',
      altText: 'Technology article preview',
      aspectRatio: '1.91:1',
      suggestedFilename: 'og-technology.jpg',
    },
    twitter: {
      id: 'twitter-1',
      type: 'twitter',
      prompt: 'Twitter card image for technology article',
      altText: 'Technology Twitter card',
      aspectRatio: '2:1',
      suggestedFilename: 'twitter-technology.jpg',
    },
    sectionImages: [
      {
        id: 'section-1',
        type: 'section',
        prompt: 'Diagram illustrating the main concept',
        altText: 'Concept diagram',
        aspectRatio: '4:3',
        suggestedFilename: 'concept-diagram.jpg',
        placementContext: 'After introduction',
      },
    ],
    styleGuide: {
      style: 'Modern minimalist',
      colorPalette: ['#2D3748', '#4299E1', '#EDF2F7'],
      mood: 'Professional and innovative',
      compositionNotes: 'Clean lines with ample white space',
    },
  },
  visualContent: {
    infographics: [
      {
        id: 'infographic-1',
        title: 'Technology Adoption Timeline',
        description: 'Visual timeline of technology adoption rates',
        dataPoints: ['2020: 30%', '2022: 50%', '2024: 75%'],
        suggestedFormat: 'vertical timeline',
        placementContext: 'Mid-article',
      },
    ],
    comparisonTables: [],
    timelines: [],
    charts: [
      {
        id: 'chart-1',
        title: 'Growth Trends',
        chartType: 'line',
        dataDescription: 'Line chart showing growth over time',
        xAxisLabel: 'Year',
        yAxisLabel: 'Percentage',
        placementContext: 'Statistics section',
      },
    ],
    diagrams: [],
    statisticsCallouts: [
      {
        id: 'stat-1',
        statistic: '75% of companies have adopted AI',
        source: 'Industry Report 2024',
        context: 'Highlights adoption rate',
        visualTreatment: 'Large number with icon',
      },
    ],
  },
  contentBlocks: {
    pullQuotes: [
      {
        id: 'quote-1',
        quote: 'Innovation distinguishes between a leader and a follower.',
        source: 'Industry Expert',
        placementContext: 'After introduction',
      },
    ],
    highlightBoxes: [
      {
        id: 'highlight-1',
        title: 'Key Insight',
        content: 'This is the most important takeaway from the article.',
        style: 'info',
        placementContext: 'Main content section',
      },
    ],
    tipBoxes: [
      {
        id: 'tip-1',
        title: 'Pro Tip',
        content: 'Start with small implementations before scaling.',
        placementContext: 'Implementation section',
      },
    ],
    warningBoxes: [],
    faqSchemaSuggestions: [
      {
        question: 'What is the main benefit?',
        answer: 'The main benefit is improved efficiency and reduced costs.',
        placementContext: 'End of article',
      },
    ],
    ctaCards: [],
    newsletterCta: {
      headline: 'Stay Updated',
      description: 'Get the latest insights delivered to your inbox.',
      incentive: 'Free guide included',
      placementContext: 'End of article',
    },
  },
  socialMetadata: {
    sharingDescription: 'Discover the latest trends in technology innovation.',
    hashtags: ['technology', 'innovation', 'AI'],
    pinterestDescription: 'Technology innovation trends and insights',
    youtubeDescriptionSuggestion: 'A comprehensive guide to technology trends in 2024',
    videoTopicSuggestions: ['Introduction to AI', 'Future of Technology'],
  },
  internalAssets: {
    relatedArticleSuggestions: [
      {
        title: 'AI Implementation Guide',
        topicOverlap: 'AI and technology implementation',
        suggestedPlacement: 'End of article',
      },
    ],
    internalLinkOpportunities: [
      {
        anchorText: 'machine learning',
        suggestedTargetTopic: 'Machine Learning Basics',
        reason: 'Relevant to the discussion on AI',
      },
    ],
    downloadableAssetSuggestions: [
      {
        title: 'Implementation Checklist',
        format: 'checklist',
        description: 'Step-by-step checklist for implementation',
        suggestedContent: '10-point checklist covering key steps',
      },
    ],
    leadMagnetSuggestions: [
      {
        title: 'Free Template Pack',
        type: 'template',
        valueProposition: 'Ready-to-use templates for quick start',
        suggestedContent: '5 customizable templates',
      },
    ],
  },
  publishingMetadata: {
    heroImageSize: { width: 1920, height: 1080 },
    featuredImageDimensions: { width: 1200, height: 630 },
    ogImageDimensions: { width: 1200, height: 630 },
    socialImageDimensions: { width: 800, height: 418 },
    accessibilityRecommendations: [
      'Ensure all images have descriptive alt text',
      'Use sufficient color contrast (4.5:1 minimum)',
    ],
    assetChecklist: [
      'Featured image',
      'Open Graph image',
      'Twitter card image',
      'Section images (1)',
      'Infographic (1)',
    ],
  },
  generationSummary:
    'Complete asset blueprint with 4 main images, 1 infographic, 1 chart, and comprehensive social metadata.',
} as const;

const BRIEF: Brief = {
  topic: 'Technology Innovation in 2024',
  targetAudience: 'Technology professionals',
  keywordHints: ['AI', 'innovation', 'technology'],
  sheetRowId: 'row-123',
} as const;

const RESEARCH: ResearchSection = {
  keyFacts: ['AI adoption is increasing', 'Cloud computing is essential'],
  suggestedAngle: 'Technical deep-dive',
  candidateStatistics: [{ claim: '75% adoption rate', informalSource: 'Industry Report' }],
} as const;

const PLANNING: PlanningSection = {
  titleCandidates: ['Technology Innovation Guide'],
  outline: [
    {
      heading: 'Introduction',
      level: 2,
      talkingPoints: ['Overview', 'Key trends'],
    },
  ],
  targetWordCount: 1500,
  angle: 'Technical deep-dive',
} as const;

const SEO: SeoSection = {
  focusKeyword: 'technology innovation',
  seoKeywords: ['AI', 'innovation', 'technology'],
  seoTitleDraft: 'Technology Innovation Guide 2024',
  metaDescriptionDraft: 'Complete guide to technology innovation.',
  internalLinkTargets: [],
} as const;

const DRAFT: DraftSection = {
  current: {
    markdown: `# Technology Innovation in 2024

[[image: Hero image placeholder]]

This is the introduction paragraph with a [[link: AI implementation guide]].

## Introduction

Content about technology innovation.

[[image: Section diagram]]

More content here.`,
    wordCount: 100,
    linkMarkers: [{ markerId: 'link-1', anchorTextHint: 'AI implementation guide' }],
    imageMarkers: [
      { markerId: 'image-1', role: 'hero', descriptionHint: 'Hero image placeholder' },
      { markerId: 'image-2', role: 'inline', descriptionHint: 'Section diagram' },
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

function createPromptRegistry(): PromptRegistry {
  return {
    get: () => Promise.resolve(MOCK_PROMPT_SET),
  };
}

function createServices(
  text: string = JSON.stringify(ASSETS_RESULT),
): ContentAssetsPlannerModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text,
      providerName: 'anthropic',
      modelId: 'claude-3-opus-20240229',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 2000, outputTokens: 4000, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0.1,
    }),
    promptRegistry: createPromptRegistry(),
  };
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

describe('contentAssetsPlannerModule', () => {
  describe('contentAssetsPlannerModuleMetadata', () => {
    it('has the correct module key', () => {
      expect(contentAssetsPlannerModuleMetadata.key).toBe('content-assets-planner');
    });

    it('has a non-empty display name', () => {
      expect(contentAssetsPlannerModuleMetadata.displayName.trim().length).toBeGreaterThan(0);
    });

    it('has a non-empty description', () => {
      expect(contentAssetsPlannerModuleMetadata.description.trim().length).toBeGreaterThan(0);
    });

    it('declares correct dependencies', () => {
      expect(contentAssetsPlannerModuleMetadata.dependencies).toEqual(
        expect.arrayContaining([
          'research',
          'planner',
          'seo-planner',
          'writer',
          'reviewer-technical',
          'humanizer',
        ]),
      );
    });

    it('declares required capabilities', () => {
      expect(contentAssetsPlannerModuleMetadata.capabilities.requires).toEqual(
        expect.arrayContaining([
          'llm.complete',
          'prompt-registry.get',
          'research.structured-output',
          'planner.content-plan',
          'seo.strategy',
          'writer.draft',
          'reviewer.technical-review',
          'humanizer.humanized-draft',
        ]),
      );
    });

    it('declares provided capabilities', () => {
      expect(contentAssetsPlannerModuleMetadata.capabilities.provides).toEqual(
        expect.arrayContaining([
          'content-assets-planner.asset-blueprint',
          'content-assets-planner.image-specifications',
          'content-assets-planner.visual-content-specs',
          'content-assets-planner.state-projection',
        ]),
      );
    });
  });

  describe('buildAssetsRequest', () => {
    it('builds a valid request from complete pipeline state', () => {
      const state = createState();
      const request = buildAssetsRequest(state);

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

      expect(() => buildAssetsRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when research is missing', () => {
      const state = createState();
      const incompleteState = { ...state, research: undefined } as PipelineState;

      expect(() => buildAssetsRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when planning is missing', () => {
      const state = createState();
      const incompleteState = { ...state, planning: undefined } as PipelineState;

      expect(() => buildAssetsRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when seo is missing', () => {
      const state = createState();
      const incompleteState = { ...state, seo: undefined } as PipelineState;

      expect(() => buildAssetsRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when draft is missing', () => {
      const state = createState();
      const incompleteState = { ...state, draft: undefined } as PipelineState;

      expect(() => buildAssetsRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when review is missing', () => {
      const state = createState();
      const incompleteState = { ...state, review: undefined } as PipelineState;

      expect(() => buildAssetsRequest(incompleteState)).toThrow(ValidationError);
    });
  });

  describe('normalizeAssetsRequest', () => {
    it('returns a frozen request object', () => {
      const request: AssetsRequest = {
        brief: BRIEF,
        research: RESEARCH,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        review: REVIEW,
      };
      const normalized = normalizeAssetsRequest(request);

      expect(Object.isFrozen(normalized)).toBe(true);
    });

    it('preserves all input fields', () => {
      const request: AssetsRequest = {
        brief: BRIEF,
        research: RESEARCH,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        review: REVIEW,
      };
      const normalized = normalizeAssetsRequest(request);

      expect(normalized.brief).toEqual(request.brief);
      expect(normalized.research).toEqual(request.research);
      expect(normalized.planning).toEqual(request.planning);
      expect(normalized.seo).toEqual(request.seo);
      expect(normalized.draft).toEqual(request.draft);
      expect(normalized.review).toEqual(request.review);
    });
  });

  describe('toAssetsSection', () => {
    it('projects assets result to minimal AssetsSection contract', () => {
      const section = toAssetsSection(ASSETS_RESULT);

      expect(section.images.featured.id).toBe(ASSETS_RESULT.images.featured.id);
      expect(section.images.featured.prompt).toBe(ASSETS_RESULT.images.featured.prompt);
      expect(section.images.sectionCount).toBe(ASSETS_RESULT.images.sectionImages.length);
      expect(section.images.styleGuide).toBe(ASSETS_RESULT.images.styleGuide.style);
      expect(section.socialHashtags).toEqual(ASSETS_RESULT.socialMetadata.hashtags);
    });
  });

  describe('createContentAssetsPlannerModule', () => {
    it('creates a module with correct metadata', () => {
      const module = createContentAssetsPlannerModule();

      expect(module.metadata).toStrictEqual(contentAssetsPlannerModuleMetadata);
    });

    it('creates a module with an execute function', () => {
      const module = createContentAssetsPlannerModule();

      expect(typeof module.execute).toBe('function');
    });
  });

  describe('registerContentAssetsPlannerModule', () => {
    it('registers the module in the registry', () => {
      const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>();

      registerContentAssetsPlannerModule(registry);

      expect(registry.has('content-assets-planner')).toBe(true);
    });

    it('returns the registry for chaining', () => {
      const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>();
      const returned = registerContentAssetsPlannerModule(registry);

      expect(returned).toBe(registry);
    });

    it('throws when registering the same module twice', () => {
      const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>();

      registerContentAssetsPlannerModule(registry);

      expect(() => registerContentAssetsPlannerModule(registry)).toThrow(RangeError);
    });
  });

  describe('createContentAssetsPlannerModuleBinding', () => {
    it('creates a binding with the correct key', () => {
      const binding = createContentAssetsPlannerModuleBinding();

      expect(binding.key).toBe('content-assets-planner');
    });

    it('creates input from pipeline state', () => {
      const binding = createContentAssetsPlannerModuleBinding();
      const state = createState();

      const input = binding.createInput(state, {} as never);

      expect(input).toBeDefined();
      expect((input as AssetsRequest).research).toBeDefined();
    });

    it('applies output to create new state with assets section', () => {
      const binding = createContentAssetsPlannerModuleBinding();
      const state = createState();
      const context = {} as never;

      const newState = binding.applyOutput(state, ASSETS_RESULT, context);

      expect((newState as PipelineState & { assets: unknown }).assets).toBeDefined();
    });

    it('preserves runId when applying output', () => {
      const binding = createContentAssetsPlannerModuleBinding();
      const state = createState();
      const context = {} as never;

      const newState = binding.applyOutput(state, ASSETS_RESULT, context);

      expect(newState.metadata.runId).toBe(state.metadata.runId);
    });
  });
});

describe('Content Assets Planner execution through ModuleRunner', () => {
  it('executes successfully and returns the assets result', async () => {
    const services = createServices();
    const module = createContentAssetsPlannerModule();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildAssetsRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.images.featured.id).toBe(ASSETS_RESULT.images.featured.id);
    expect(result.output.generationSummary).toBe(ASSETS_RESULT.generationSummary);
  });

  it('calls the LLM provider with correct parameters', async () => {
    const services = createServices();
    const module = createContentAssetsPlannerModule();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);
    const state = createState();

    await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildAssetsRequest(state),
      state,
      services,
    );

    const llmProvider = services.llmProvider as FakeLLMProvider;
    expect(llmProvider.calls).toHaveLength(1);
    expect(llmProvider.calls[0]?.moduleKey).toBe('content-assets-planner');
    expect(llmProvider.calls[0]?.responseFormat).toBe('json');
    expect(llmProvider.calls[0]?.maxOutputTokens).toBe(12000);
  });

  it('records cost events for successful execution', async () => {
    const services = createServices();
    const module = createContentAssetsPlannerModule();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildAssetsRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(result.state.metrics.costEvents[0]?.outcome).toBe('success');
  });

  it('records cost events for validation errors', async () => {
    const services = createServices('{"invalid": true}');
    const module = createContentAssetsPlannerModule();
    const state = createState();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildAssetsRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(result.state.metrics.costEvents[0]?.outcome).toBe('validationError');
    expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('falls back to local JSON parsing when the provider lacks JSON-schema support', async () => {
    const services: ContentAssetsPlannerModuleServices = {
      llmProvider: new FakeLLMProvider({
        text: JSON.stringify(ASSETS_RESULT),
        capabilities: { vision: false, jsonSchema: false, caching: false, reasoning: false },
        providerName: 'anthropic',
        modelId: 'claude-3-opus-20240229',
        pricingVerifiedAt: '2026-07-01',
      }),
      promptRegistry: createPromptRegistry(),
    };
    const module = createContentAssetsPlannerModule();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildAssetsRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    const llmProvider = services.llmProvider as FakeLLMProvider;
    expect(llmProvider.calls[0]?.jsonSchema).toBeUndefined();
  });

  it('returns a typed validation failure for malformed provider output', async () => {
    const services = createServices('{"not":"the expected schema"}');
    const module = createContentAssetsPlannerModule();
    const state = createState();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildAssetsRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.state.metrics.costEvents).toHaveLength(1);
    expect(result.state.metrics.costEvents[0]?.outcome).toBe('validationError');
    expect(result.state.errors[0]?.errorClass).toBe('ValidationError');
  });
});

describe('Content Assets Planner registry and orchestrator compatibility', () => {
  it('declares frozen dependencies and capabilities and registers independently', () => {
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>();
    registerContentAssetsPlannerModule(registry);

    const module = registry.require('content-assets-planner');
    expect(module.metadata.dependencies).toEqual([
      'research',
      'planner',
      'seo-planner',
      'writer',
      'reviewer-technical',
      'humanizer',
    ]);
    expect(module.metadata.capabilities).toEqual({
      requires: [
        'llm.complete',
        'prompt-registry.get',
        'research.structured-output',
        'planner.content-plan',
        'seo.strategy',
        'writer.draft',
        'reviewer.technical-review',
        'humanizer.humanized-draft',
      ],
      provides: [
        'content-assets-planner.asset-blueprint',
        'content-assets-planner.image-specifications',
        'content-assets-planner.visual-content-specs',
        'content-assets-planner.state-projection',
      ],
    });
  });

  it('registers and executes through the orchestrator binding', async () => {
    const services = createServices();
    const module = createContentAssetsPlannerModule();
    const registry = createModuleRegistry<ContentAssetsPlannerModuleServices>().register(module);
    const state = createState();
    const binding = createContentAssetsPlannerModuleBinding();
    const context = {} as never;

    const input = binding.createInput(state, context);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as AssetsRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, context);
    expect(
      (newState as PipelineState & { assets: { images: { featured: { id: string } } } }).assets
        .images.featured.id,
    ).toBe(ASSETS_RESULT.images.featured.id);
  });
});

describe('AssetsResultSchema', () => {
  it('validates a correct result', () => {
    const parsed = AssetsResultSchema.safeParse(ASSETS_RESULT);

    expect(parsed.success).toBe(true);
  });

  it('rejects result with missing required fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { generationSummary: _removed, ...incomplete } = ASSETS_RESULT;

    const parsed = AssetsResultSchema.safeParse(incomplete);

    expect(parsed.success).toBe(false);
  });

  it('rejects result with invalid image type', () => {
    const result = {
      ...ASSETS_RESULT,
      images: {
        ...ASSETS_RESULT.images,
        featured: {
          ...ASSETS_RESULT.images.featured,
          type: 'invalid-type',
        },
      },
    };

    const parsed = AssetsResultSchema.safeParse(result);

    expect(parsed.success).toBe(false);
  });

  it('rejects result with invalid chart type', () => {
    const result = {
      ...ASSETS_RESULT,
      visualContent: {
        ...ASSETS_RESULT.visualContent,
        charts: [
          {
            ...ASSETS_RESULT.visualContent.charts[0],
            chartType: 'invalid-chart',
          },
        ],
      },
    };

    const parsed = AssetsResultSchema.safeParse(result);

    expect(parsed.success).toBe(false);
  });

  it('rejects result with negative dimensions', () => {
    const result = {
      ...ASSETS_RESULT,
      publishingMetadata: {
        ...ASSETS_RESULT.publishingMetadata,
        heroImageSize: { width: -100, height: 100 },
      },
    };

    const parsed = AssetsResultSchema.safeParse(result);

    expect(parsed.success).toBe(false);
  });
});
