/** Tests for the FAQ Generator module and its pipeline adapters. */

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

import {
  buildFaqGeneratorRequest,
  createFaqGeneratorModule,
  createFaqGeneratorModuleBinding,
  FaqGeneratorResultSchema,
  faqGeneratorModuleMetadata,
  type FaqGeneratorModuleServices,
  type FaqGeneratorRequest,
} from '../faqGeneratorModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the faq generator.',
  user: 'Generate the FAQ.',
  promptVersion: 'abc1234',
});

const SEO: SeoSection = {
  focusKeyword: 'direct booking hotels',
  seoKeywords: ['direct booking'],
  seoTitleDraft: 'Direct booking guide',
  metaDescriptionDraft:
    'OTA platforms quietly drain independent hotel margin. Here is how a direct booking engine reclaims revenue.',
  internalLinkTargets: [],
};

const DRAFT: DraftSection = {
  current: {
    markdown: 'Article about direct booking engines and how they reclaim hotel revenue for owners.',
    wordCount: 15,
    linkMarkers: [],
    imageMarkers: [],
  },
  history: [],
};

const FAQ_JSON = {
  faq: [
    {
      question: 'How does direct booking increase hotel revenue?',
      answer:
        'Direct booking removes third-party commission, so every reservation keeps more of its value for the property.',
    },
    {
      question: 'What tools do hotels need for direct booking?',
      answer:
        'A booking engine with a live room matrix, payment processing, and channel management covers the core needs.',
    },
    {
      question: 'Is direct booking worth the effort for small hotels?',
      answer:
        'Yes, small hotels typically recover their setup costs within a few months once commission savings accumulate.',
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

function createServices(text: string = JSON.stringify(FAQ_JSON)): FaqGeneratorModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text,
      providerName: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 500, outputTokens: 300, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0.005,
    }),
    promptRegistry: {
      get: () => Promise.resolve(MOCK_PROMPT_SET),
    },
  };
}

function createState(): PipelineState {
  return { ...createInitialState(), seo: SEO, draft: DRAFT };
}

describe('faqGeneratorModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(faqGeneratorModuleMetadata.key).toBe('faq-generator');
    expect(faqGeneratorModuleMetadata.dependencies).toEqual(['seo-planner', 'writer', 'humanizer']);
  });
});

describe('FaqGeneratorResultSchema', () => {
  it('accepts a valid FAQ list', () => {
    expect(FaqGeneratorResultSchema.safeParse(FAQ_JSON).success).toBe(true);
  });

  it('rejects more than 10 items', () => {
    const tooMany = {
      faq: Array.from({ length: 11 }, (_, i) => ({
        question: `Question number ${i} about hotel bookings?`,
        answer: 'This answer is long enough to satisfy the minimum length requirement.',
      })),
    };
    expect(FaqGeneratorResultSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects duplicate questions and over-long questions', () => {
    const bad = {
      faq: [
        { question: 'Same question again?', answer: 'A sufficiently long answer here.' },
        { question: 'Same question again?', answer: 'A sufficiently long answer here.' },
        {
          question: 'q'.repeat(161),
          answer: 'A sufficiently long answer here.',
        },
      ],
    };
    expect(FaqGeneratorResultSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects answers shorter than 20 characters', () => {
    const bad = {
      faq: [
        { question: 'Is this a valid FAQ question?', answer: 'Too short.' },
        {
          question: 'Another valid-looking question?',
          answer: 'A sufficiently long answer here.',
        },
        {
          question: 'Yet another valid-looking question?',
          answer: 'A sufficiently long answer here.',
        },
      ],
    };
    expect(FaqGeneratorResultSchema.safeParse(bad).success).toBe(false);
  });
});

describe('faqGeneratorModule via the orchestrator binding', () => {
  it('writes sanity.faq with generated keys through the module runner', async () => {
    const services = createServices();
    const module = createFaqGeneratorModule();
    const registry = createModuleRegistry<FaqGeneratorModuleServices>().register(module);
    const state = createState();
    const binding = createFaqGeneratorModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as FaqGeneratorRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.sanity?.faq).toHaveLength(3);
    expect(newState.sanity?.faq?.[0]).toMatchObject({
      _type: 'faqItem',
      _key: 'faq1',
    });
  });

  it('rejects a missing seo or draft section', () => {
    expect(() => buildFaqGeneratorRequest(createInitialState())).toThrow(ValidationError);
  });
});
