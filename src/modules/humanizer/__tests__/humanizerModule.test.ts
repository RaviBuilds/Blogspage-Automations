/** Tests for the provider-agnostic Humanizer module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
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
  buildHumanizerRequest,
  createHumanizerModule,
  createHumanizerModuleBinding,
  humanizerModuleMetadata,
  HumanizedResultSchema,
  normalizeHumanizerRequest,
  registerHumanizerModule,
  toDraft,
  type HumanizedResult,
  type HumanizerModuleServices,
  type HumanizerRequest,
} from '../humanizerModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the humanizer.',
  user: 'Humanize the draft.',
  promptVersion: 'abc1234',
});

const RESULT: HumanizedResult = {
  markdown: `# Test Article

[[image: Hero image placeholder]]

This is an improved introduction paragraph with a [[link: example link text]].

## Introduction

Enhanced content here with natural flow.

[[image: Inline image placeholder]]

More engaging content.
`,
  wordCount: 55,
  linkMarkers: [
    {
      markerId: 'link-1',
      anchorTextHint: 'example link text',
    },
  ],
  imageMarkers: [
    {
      markerId: 'image-1',
      role: 'hero',
      descriptionHint: 'Hero image placeholder',
    },
    {
      markerId: 'image-2',
      role: 'inline',
      descriptionHint: 'Inline image placeholder',
    },
  ],
  humanizationSummary: 'Improved sentence flow and removed AI-style phrasing.',
  improvementStatistics: {
    transitionsImproved: 3,
    hedgingPhrasesRemoved: 2,
    repetitiveStructuresFixed: 1,
    sentenceVarietyIncreased: 4,
    passiveToActive: 2,
    fillerWordsRemoved: 5,
  },
  readabilityImprovementScore: 85,
  fluencyScore: 88,
  naturalnessScore: 90,
  styleConsistencyScore: 87,
  overallQualityScore: {
    score: 88,
    reasoning: 'High-quality humanization with improved flow and natural phrasing.',
  },
} as const;

const RESEARCH: ResearchSection = {
  keyFacts: ['Fact 1', 'Fact 2'],
  suggestedAngle: 'Technical deep-dive',
  candidateStatistics: [],
} as const;

const PLANNING: PlanningSection = {
  titleCandidates: ['Test Title'],
  outline: [
    {
      heading: 'Introduction',
      level: 2,
      talkingPoints: ['Point 1', 'Point 2'],
    },
  ],
  targetWordCount: 1500,
  angle: 'Technical deep-dive',
} as const;

const SEO: SeoSection = {
  focusKeyword: 'test keyword',
  seoKeywords: ['test', 'keyword'],
  seoTitleDraft: 'Test Title',
  metaDescriptionDraft: 'Test description for SEO.',
  internalLinkTargets: [],
} as const;

const DRAFT: DraftSection = {
  current: {
    markdown: `# Test Article

[[image: Hero image placeholder]]

This is the introduction paragraph with a [[link: example link text]].

## Introduction

Some content here.

[[image: Inline image placeholder]]

More content.
`,
    wordCount: 50,
    linkMarkers: [
      {
        markerId: 'link-1',
        anchorTextHint: 'example link text',
      },
    ],
    imageMarkers: [
      {
        markerId: 'image-1',
        role: 'hero',
        descriptionHint: 'Hero image placeholder',
      },
      {
        markerId: 'image-2',
        role: 'inline',
        descriptionHint: 'Inline image placeholder',
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

function createPromptRegistry(): PromptRegistry {
  return {
    get: () => Promise.resolve(MOCK_PROMPT_SET),
  };
}

function createServices(text: string = JSON.stringify(RESULT)): HumanizerModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text,
      providerName: 'anthropic',
      modelId: 'claude-3-opus-20240229',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 1000, outputTokens: 2000, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0.05,
    }),
    promptRegistry: createPromptRegistry(),
  };
}

function createState(): PipelineState {
  const base = createInitialState();
  return {
    ...base,
    research: RESEARCH,
    planning: PLANNING,
    seo: SEO,
    draft: DRAFT,
    review: REVIEW,
  };
}

describe('humanizerModule', () => {
  describe('humanizerModuleMetadata', () => {
    it('has the correct module key', () => {
      expect(humanizerModuleMetadata.key).toBe('humanizer');
    });

    it('has a non-empty display name', () => {
      expect(humanizerModuleMetadata.displayName.trim().length).toBeGreaterThan(0);
    });

    it('has a non-empty description', () => {
      expect(humanizerModuleMetadata.description.trim().length).toBeGreaterThan(0);
    });

    it('declares correct dependencies', () => {
      expect(humanizerModuleMetadata.dependencies).toEqual(
        expect.arrayContaining([
          'research',
          'planner',
          'seo-planner',
          'writer',
          'reviewer-technical',
        ]),
      );
    });

    it('declares required capabilities', () => {
      expect(humanizerModuleMetadata.capabilities.requires).toEqual(
        expect.arrayContaining([
          'llm.complete',
          'prompt-registry.get',
          'research.structured-output',
          'planner.content-plan',
          'seo.strategy',
          'writer.draft',
          'reviewer.technical-review',
        ]),
      );
    });

    it('declares provided capabilities', () => {
      expect(humanizerModuleMetadata.capabilities.provides).toEqual(
        expect.arrayContaining(['humanizer.humanized-draft', 'humanizer.state-projection']),
      );
    });
  });

  describe('buildHumanizerRequest', () => {
    it('builds a valid request from complete pipeline state', () => {
      const state = createState();
      const request = buildHumanizerRequest(state);

      expect(request.research).toEqual(RESEARCH);
      expect(request.planning).toEqual(PLANNING);
      expect(request.seo).toEqual(SEO);
      expect(request.draft).toEqual(DRAFT);
      expect(request.review).toEqual(REVIEW);
    });

    it('throws ValidationError when research is missing', () => {
      const state = createState();
      const incompleteState = { ...state, research: undefined } as PipelineState;

      expect(() => buildHumanizerRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when planning is missing', () => {
      const state = createState();
      const incompleteState = { ...state, planning: undefined } as PipelineState;

      expect(() => buildHumanizerRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when seo is missing', () => {
      const state = createState();
      const incompleteState = { ...state, seo: undefined } as PipelineState;

      expect(() => buildHumanizerRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when draft is missing', () => {
      const state = createState();
      const incompleteState = { ...state, draft: undefined } as PipelineState;

      expect(() => buildHumanizerRequest(incompleteState)).toThrow(ValidationError);
    });

    it('throws ValidationError when review is missing', () => {
      const state = createState();
      const incompleteState = { ...state, review: undefined } as PipelineState;

      expect(() => buildHumanizerRequest(incompleteState)).toThrow(ValidationError);
    });
  });

  describe('normalizeHumanizerRequest', () => {
    it('returns a frozen request object', () => {
      const request: HumanizerRequest = {
        research: RESEARCH,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        review: REVIEW,
      };
      const normalized = normalizeHumanizerRequest(request);

      expect(Object.isFrozen(normalized)).toBe(true);
    });

    it('preserves all input fields', () => {
      const request: HumanizerRequest = {
        research: RESEARCH,
        planning: PLANNING,
        seo: SEO,
        draft: DRAFT,
        review: REVIEW,
      };
      const normalized = normalizeHumanizerRequest(request);

      expect(normalized.research).toEqual(request.research);
      expect(normalized.planning).toEqual(request.planning);
      expect(normalized.seo).toEqual(request.seo);
      expect(normalized.draft).toEqual(request.draft);
      expect(normalized.review).toEqual(request.review);
    });
  });

  describe('toDraft', () => {
    it('projects humanized result to minimal Draft contract', () => {
      const draft = toDraft(RESULT);

      expect(draft.markdown.trim()).toBe(RESULT.markdown.trim());
      expect(draft.wordCount).toBe(RESULT.wordCount);
      expect(draft.linkMarkers).toEqual(RESULT.linkMarkers);
      expect(draft.imageMarkers).toEqual(RESULT.imageMarkers);
    });
  });

  describe('createHumanizerModule', () => {
    it('creates a module with correct metadata', () => {
      const module = createHumanizerModule();

      expect(module.metadata).toStrictEqual(humanizerModuleMetadata);
    });

    it('creates a module with an execute function', () => {
      const module = createHumanizerModule();

      expect(typeof module.execute).toBe('function');
    });
  });

  describe('registerHumanizerModule', () => {
    it('registers the module in the registry', () => {
      const registry = createModuleRegistry<HumanizerModuleServices>();

      registerHumanizerModule(registry);

      expect(registry.has('humanizer')).toBe(true);
    });

    it('returns the registry for chaining', () => {
      const registry = createModuleRegistry<HumanizerModuleServices>();
      const returned = registerHumanizerModule(registry);

      expect(returned).toBe(registry);
    });

    it('throws when registering the same module twice', () => {
      const registry = createModuleRegistry<HumanizerModuleServices>();

      registerHumanizerModule(registry);

      expect(() => registerHumanizerModule(registry)).toThrow(RangeError);
    });
  });

  describe('createHumanizerModuleBinding', () => {
    it('creates a binding with the correct key', () => {
      const binding = createHumanizerModuleBinding();

      expect(binding.key).toBe('humanizer');
    });

    it('creates input from pipeline state', () => {
      const binding = createHumanizerModuleBinding();
      const state = createState();

      const input = binding.createInput(state, {} as never);

      expect(input).toBeDefined();
      expect((input as HumanizerRequest).research).toBeDefined();
    });

    it('applies output to create new state with updated draft', () => {
      const binding = createHumanizerModuleBinding();
      const state = createState();
      const context = {} as never;

      const newState = binding.applyOutput(state, RESULT, context);

      expect(newState.draft).toBeDefined();
      expect(newState.draft?.current.markdown.trim()).toBe(RESULT.markdown.trim());
      expect(newState.draft?.current.wordCount).toBe(RESULT.wordCount);
    });

    it('preserves runId when applying output', () => {
      const binding = createHumanizerModuleBinding();
      const state = createState();
      const context = {} as never;

      const newState = binding.applyOutput(state, RESULT, context);

      expect(newState.metadata.runId).toBe(state.metadata.runId);
    });

    it('adds previous draft to history', () => {
      const binding = createHumanizerModuleBinding();
      const state = createState();
      const context = {} as never;

      const newState = binding.applyOutput(state, RESULT, context);

      expect(newState.draft?.history.length).toBe(1);
      expect(newState.draft?.history[0]?.producedBy).toBe('humanizer');
    });
  });
});

describe('Humanizer execution through ModuleRunner', () => {
  it('executes successfully and returns the humanized result', async () => {
    const services = createServices();
    const module = createHumanizerModule();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildHumanizerRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.output.markdown.trim()).toBe(RESULT.markdown.trim());
    expect(result.output.wordCount).toBe(RESULT.wordCount);
    expect(result.output.humanizationSummary).toBe(RESULT.humanizationSummary);
  });

  it('calls the LLM provider with correct parameters', async () => {
    const services = createServices();
    const module = createHumanizerModule();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);
    const state = createState();

    await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildHumanizerRequest(state),
      state,
      services,
    );

    const llmProvider = services.llmProvider as FakeLLMProvider;
    expect(llmProvider.calls).toHaveLength(1);
    expect(llmProvider.calls[0]?.moduleKey).toBe('humanizer');
    expect(llmProvider.calls[0]?.responseFormat).toBe('json');
    expect(llmProvider.calls[0]?.maxOutputTokens).toBe(8000);
  });

  it('records cost events for successful execution', async () => {
    const services = createServices();
    const module = createHumanizerModule();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildHumanizerRequest(state),
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
    const module = createHumanizerModule();
    const state = createState();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildHumanizerRequest(state),
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
    const services: HumanizerModuleServices = {
      llmProvider: new FakeLLMProvider({
        text: JSON.stringify(RESULT),
        capabilities: { vision: false, jsonSchema: false, caching: false, reasoning: false },
        providerName: 'anthropic',
        modelId: 'claude-3-opus-20240229',
        pricingVerifiedAt: '2026-07-01',
      }),
      promptRegistry: createPromptRegistry(),
    };
    const module = createHumanizerModule();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);
    const state = createState();

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildHumanizerRequest(state),
      state,
      services,
    );

    expect(result.ok).toBe(true);
    const llmProvider = services.llmProvider as FakeLLMProvider;
    expect(llmProvider.calls[0]?.jsonSchema).toBeUndefined();
  });

  it('returns a typed validation failure for malformed provider output', async () => {
    const services = createServices('{"not":"the expected schema"}');
    const module = createHumanizerModule();
    const state = createState();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);

    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      buildHumanizerRequest(state),
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

describe('Humanizer registry and orchestrator compatibility', () => {
  it('declares frozen dependencies and capabilities and registers independently', () => {
    const registry = createModuleRegistry<HumanizerModuleServices>();
    registerHumanizerModule(registry);

    const module = registry.require('humanizer');
    expect(module.metadata.dependencies).toEqual([
      'research',
      'planner',
      'seo-planner',
      'writer',
      'reviewer-technical',
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
      ],
      provides: ['humanizer.humanized-draft', 'humanizer.state-projection'],
    });
  });

  it('registers and executes through the orchestrator binding', async () => {
    const services = createServices();
    const module = createHumanizerModule();
    const registry = createModuleRegistry<HumanizerModuleServices>().register(module);
    const state = createState();
    const binding = createHumanizerModuleBinding();
    const context = {} as never;

    const input = binding.createInput(state, context);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as HumanizerRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, context);
    expect(newState.draft?.current.markdown.trim()).toBe(RESULT.markdown.trim());
    expect(newState.draft?.history[0]?.producedBy).toBe('humanizer');
  });
});

describe('HumanizedResultSchema', () => {
  it('validates a correct result', () => {
    const parsed = HumanizedResultSchema.safeParse(RESULT);

    expect(parsed.success).toBe(true);
  });

  it('rejects result without hero image marker', () => {
    const result = {
      ...RESULT,
      imageMarkers: [
        {
          markerId: 'image-1',
          role: 'inline' as const,
          descriptionHint: 'Inline image',
        },
        {
          markerId: 'image-2',
          role: 'inline' as const,
          descriptionHint: 'Another inline image',
        },
      ],
    };

    const parsed = HumanizedResultSchema.safeParse(result);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message);
      expect(issues.some((m) => m.includes('hero'))).toBe(true);
    }
  });

  it('rejects result with missing required fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { humanizationSummary: _removed, ...incomplete } = RESULT;

    const parsed = HumanizedResultSchema.safeParse(incomplete);

    expect(parsed.success).toBe(false);
  });

  it('rejects result with scores outside 0-100 range', () => {
    const result = {
      ...RESULT,
      readabilityImprovementScore: 150,
    };

    const parsed = HumanizedResultSchema.safeParse(result);

    expect(parsed.success).toBe(false);
  });

  it('rejects result with inconsistent overall score', () => {
    const result = {
      ...RESULT,
      overallQualityScore: {
        score: 10,
        reasoning: 'Way off from the average',
      },
    };

    const parsed = HumanizedResultSchema.safeParse(result);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message);
      expect(issues.some((m) => m.includes('overallQualityScore'))).toBe(true);
    }
  });
});
