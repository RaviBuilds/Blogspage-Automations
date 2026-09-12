/** Tests for the SEO Reviewer module and its pipeline adapters. */

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
  buildSeoReviewRequest,
  createSeoReviewerModule,
  createSeoReviewerModuleBinding,
  seoReviewerModuleMetadata,
  type SeoReviewerModuleServices,
  type SeoReviewRequest,
} from '../seoReviewerModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the seo reviewer.',
  user: 'Review the draft.',
  promptVersion: 'abc1234',
});

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
    markdown:
      'Article about direct booking engines and their revenue impact for independent hotels.',
    wordCount: 15,
    linkMarkers: [],
    imageMarkers: [],
  },
  history: [],
};

const REVIEW_JSON = {
  passed: true,
  issues: [],
};

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(text: string = JSON.stringify(REVIEW_JSON)): SeoReviewerModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text,
      providerName: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 500, outputTokens: 200, cachedInputTokens: 0, reasoningTokens: 0 },
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

describe('seoReviewerModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(seoReviewerModuleMetadata.key).toBe('reviewer-seo');
    expect(seoReviewerModuleMetadata.dependencies).toEqual(['seo-planner', 'writer', 'humanizer']);
  });
});

describe('seoReviewerModule via the orchestrator binding', () => {
  it('writes review.seo through the module runner', async () => {
    const services = createServices();
    const module = createSeoReviewerModule();
    const registry = createModuleRegistry<SeoReviewerModuleServices>().register(module);
    const state = createState();
    const binding = createSeoReviewerModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as SeoReviewRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.review?.seo?.passed).toBe(true);
    expect(newState.review?.loop?.iteration ?? 0).toBe(0);
  });

  it('rejects a missing seo or draft', () => {
    expect(() => buildSeoReviewRequest(createInitialState())).toThrow(ValidationError);
  });
});
