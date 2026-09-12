/** Tests for the Article Improver module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type DraftSection,
  type PipelineState,
  type QaSection,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptSet } from '@/prompts/registry.js';

import {
  buildImproverRequest,
  createImproverModule,
  createImproverModuleBinding,
  improverModuleMetadata,
  type ImproverModuleServices,
  type ImproverRequest,
} from '../improverModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the article improver.',
  user: 'Repair the draft.',
  promptVersion: 'abc1234',
});

const QA: QaSection = {
  decision: 'needsRevision',
  remainingIssues: [
    {
      id: 'seo-1',
      severity: 'medium',
      location: 'intro',
      description: 'Focus keyword missing from the first paragraph.',
      suggestedFix: 'Add the focus keyword naturally.',
    },
  ],
};

const DRAFT: DraftSection = {
  current: {
    markdown: 'An article about hotel booking without the focus keyword.',
    wordCount: 12,
    linkMarkers: [{ markerId: 'link-1', anchorTextHint: 'Direct booking guide' }],
    imageMarkers: [{ markerId: 'inline-1', role: 'inline', descriptionHint: 'Diagram' }],
  },
  history: [],
};

const REPAIRED_MARKDOWN =
  'An article about direct booking for hotels, with the focus keyword in the first sentence.';

class FakeClock implements ModuleRunnerClock {
  public now(): Date {
    return new Date('2026-07-25T10:00:00.000Z');
  }

  public monotonicNow(): number {
    return 0;
  }
}

function createServices(): ImproverModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text: JSON.stringify({
        markdown: REPAIRED_MARKDOWN,
        wordCount: 14,
        linkMarkers: DRAFT.current.linkMarkers,
        imageMarkers: DRAFT.current.imageMarkers,
      }),
      providerName: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 800, outputTokens: 400, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0.006,
    }),
    promptRegistry: {
      get: () => Promise.resolve(MOCK_PROMPT_SET),
    },
  };
}

function createState(): PipelineState {
  return { ...createInitialState(), qa: QA, draft: DRAFT };
}

describe('improverModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(improverModuleMetadata.key).toBe('improver');
    expect(improverModuleMetadata.dependencies).toEqual([
      'qa',
      'reviewer-technical',
      'reviewer-seo',
      'humanizer',
    ]);
  });
});

describe('improverModule via the orchestrator binding', () => {
  it('replaces the current draft and appends the previous one to history', async () => {
    const services = createServices();
    const module = createImproverModule();
    const registry = createModuleRegistry<ImproverModuleServices>().register(module);
    const state = createState();
    const binding = createImproverModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as ImproverRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.draft?.current?.markdown).toBe(REPAIRED_MARKDOWN);
    expect(newState.draft?.history).toHaveLength(1);
    expect(newState.draft?.history[0]?.producedBy).toBe('improver');
    expect(newState.draft?.history[0]?.draft.markdown).toBe(DRAFT.current.markdown);
  });

  it('rejects a state without a qa section', () => {
    expect(() => buildImproverRequest(createInitialState())).toThrow(ValidationError);
  });
});
