/** Tests for the provider-agnostic Image Planner module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type DraftSection,
  type ImagePlan,
  type PipelineState,
  type PlanningSection,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptRegistry, PromptSet } from '@/prompts/registry.js';

import {
  assertMarkerCoverage,
  buildImagePlannerRequest,
  createImagePlannerModule,
  createImagePlannerModuleBinding,
  formatImageMarkers,
  imagePlannerModuleMetadata,
  ImagePlannerResultSchema,
  type ImagePlannerModuleServices,
  type ImagePlannerRequest,
  registerImagePlannerModule,
} from '../imagePlannerModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the image planner.',
  user: 'Plan the images.',
  promptVersion: 'abc1234',
});

const PLANNING: PlanningSection = {
  titleCandidates: ['The Future of Hotel Booking'],
  outline: [
    {
      heading: 'Intro',
      level: 2,
      talkingPoints: ['Why direct booking matters'],
    },
  ],
  targetWordCount: 1200,
  angle: 'Why direct booking beats OTAs for independent hotels',
};

const DRAFT: DraftSection = {
  current: {
    markdown: 'Article body with image markers.\n\n![Inline diagram](inline-1)',
    wordCount: 120,
    linkMarkers: [],
    imageMarkers: [
      { markerId: 'inline-1', role: 'inline', descriptionHint: 'Diagram of direct booking flow' },
    ],
  },
  history: [],
};

const IMAGE_PLAN: ImagePlan = {
  images: [
    {
      id: 'hero',
      role: 'hero',
      prompt: 'A modern hotel front desk with a live room availability dashboard, warm lighting',
      altTextDraft: 'Hotel front desk dashboard showing a live room matrix',
      aspectRatio: '1200x630',
    },
    {
      id: 'inline-1',
      role: 'inline',
      prompt: 'Flow diagram of direct booking vs OTA steps',
      altTextDraft: 'Step-by-step direct booking flow diagram',
      aspectRatio: '4:3',
      placementMarkerId: 'inline-1',
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

function createPromptRegistry(): PromptRegistry {
  return {
    get: () => Promise.resolve(MOCK_PROMPT_SET),
  };
}

function createServices(text: string = JSON.stringify(IMAGE_PLAN)): ImagePlannerModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text,
      providerName: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 1000, outputTokens: 1200, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0.01,
    }),
    promptRegistry: createPromptRegistry(),
  };
}

function createState(): PipelineState {
  const base = createInitialState();
  return {
    ...base,
    planning: PLANNING,
    draft: DRAFT,
  };
}

describe('imagePlannerModule', () => {
  it('produces an images.plan through the orchestrator binding', async () => {
    const services = createServices();
    const module = createImagePlannerModule();
    const registry = createModuleRegistry<ImagePlannerModuleServices>().register(module);
    const state = createState();
    const binding = createImagePlannerModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as ImagePlannerRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.images?.plan?.images).toEqual(IMAGE_PLAN.images);
  });

  it('passes the angle and the rendered image-marker list to the prompt', async () => {
    const services = createServices();
    const module = createImagePlannerModule();
    const registry = createModuleRegistry<ImagePlannerModuleServices>().register(module);
    const state = createState();
    const binding = createImagePlannerModuleBinding();

    const input = binding.createInput(state, {} as never);
    await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as ImagePlannerRequest,
      state,
      services,
    );

    expect((services.llmProvider as FakeLLMProvider).calls).toHaveLength(1);
    const call = (services.llmProvider as FakeLLMProvider).calls[0];
    expect(call?.systemPrompt).toBe(MOCK_PROMPT_SET.system);
    expect(call?.userPrompt).toContain(MOCK_PROMPT_SET.user);
  });

  it('fails when an inline image marker from the draft is left uncovered', async () => {
    const planMissingMarker: ImagePlan = {
      images: [IMAGE_PLAN.images[0]!],
    };
    const services = createServices(JSON.stringify(planMissingMarker));
    const module = createImagePlannerModule();
    const registry = createModuleRegistry<ImagePlannerModuleServices>().register(module);
    const state = createState();
    const binding = createImagePlannerModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as ImagePlannerRequest,
      state,
      services,
    );

    expect(result.ok).toBe(false);
  });
});

describe('ImagePlannerResultSchema', () => {
  it('accepts a valid plan', () => {
    expect(ImagePlannerResultSchema.safeParse(IMAGE_PLAN).success).toBe(true);
  });

  it('rejects a plan with multiple hero images', () => {
    const twoHeroes: ImagePlan = {
      images: [...IMAGE_PLAN.images, { ...IMAGE_PLAN.images[0]! }],
    };
    expect(ImagePlannerResultSchema.safeParse(twoHeroes).success).toBe(false);
  });

  it('rejects a hero image whose aspect ratio is not 1200x630', () => {
    const badHero: ImagePlan = {
      images: [{ ...IMAGE_PLAN.images[0]!, aspectRatio: '4:3' }],
    };
    expect(ImagePlannerResultSchema.safeParse(badHero).success).toBe(false);
  });

  it('rejects an inline image without a placementMarkerId', () => {
    const inline = IMAGE_PLAN.images[1];
    const badPlan: ImagePlan = {
      images: [
        IMAGE_PLAN.images[0]!,
        {
          id: inline?.id ?? 'inline-1',
          role: 'inline',
          prompt: inline?.prompt ?? 'x',
          altTextDraft: inline?.altTextDraft ?? 'y',
          aspectRatio: inline?.aspectRatio ?? '4:3',
        },
      ],
    };
    expect(ImagePlannerResultSchema.safeParse(badPlan).success).toBe(false);
  });
});

describe('imagePlanner helpers', () => {
  it('formats image markers as a markdown list', () => {
    expect(
      formatImageMarkers([
        { markerId: 'hero', role: 'hero', descriptionHint: 'Header image' },
        { markerId: 'inline-1', role: 'inline', descriptionHint: 'Flow diagram' },
      ]),
    ).toBe('- [HERO] hero: Header image\n- [INLINE] inline-1: Flow diagram');
    expect(formatImageMarkers([])).toBe('- None');
  });

  it('asserts every inline marker is covered exactly once', () => {
    expect(() => assertMarkerCoverage(IMAGE_PLAN, DRAFT.current.imageMarkers)).not.toThrow();
    expect(() =>
      assertMarkerCoverage({ images: [IMAGE_PLAN.images[0]!] }, DRAFT.current.imageMarkers),
    ).toThrow(ValidationError);
  });

  it('rejects missing planning or draft in the request builder', () => {
    expect(() => buildImagePlannerRequest(createInitialState())).toThrow(ValidationError);
    const withPlanningOnly = {
      ...createInitialState(),
      planning: PLANNING,
    } as PipelineState;
    expect(() => buildImagePlannerRequest(withPlanningOnly)).toThrow(ValidationError);
  });

  it('registers without side effects', () => {
    const registry = createModuleRegistry<ImagePlannerModuleServices>();
    registerImagePlannerModule(registry);
    expect(registry.list().map((module) => module.key)).toEqual(['image-planner']);
  });
  describe('imagePlannerModuleMetadata', () => {
    it('has the correct module key and dependencies', () => {
      expect(imagePlannerModuleMetadata.key).toBe('image-planner');
      expect(imagePlannerModuleMetadata.displayName).toBe('Image Planner');
      expect(imagePlannerModuleMetadata.dependencies).toEqual(['planner', 'writer', 'humanizer']);
      expect(imagePlannerModuleMetadata.capabilities).toEqual({
        requires: [
          'llm.complete',
          'prompt-registry.get',
          'planner.content-plan',
          'writer.draft',
          'humanizer.humanized-draft',
        ],
        provides: ['image-planner.image-plan'],
      });
    });
  });
});
