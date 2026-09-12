/** Tests for the QA Gate module and its pipeline adapters. */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import { createModuleRegistry, ModuleRunner, type ModuleRunnerClock } from '@/core/moduleRunner.js';
import {
  createInitialState,
  type DraftSection,
  type PipelineState,
  type ReviewOutput,
} from '@/core/state.js';
import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';
import type { PromptSet } from '@/prompts/registry.js';

import {
  buildQaRequest,
  createQaModule,
  createQaModuleBinding,
  qaModuleMetadata,
  type QaModuleServices,
  type QaRequest,
} from '../qaModule.js';

const MOCK_PROMPT_SET: PromptSet = Object.freeze({
  system: 'You are the qa gate.',
  user: 'Decide.',
  promptVersion: 'abc1234',
});

const DRAFT: DraftSection = {
  current: {
    markdown: 'Repaired article body.',
    wordCount: 10,
    linkMarkers: [],
    imageMarkers: [],
  },
  history: [],
};

const REVIEW: ReviewOutput = {
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

function createServices(decision: string = 'pass'): QaModuleServices {
  return {
    llmProvider: new FakeLLMProvider({
      text: JSON.stringify({
        decision,
        remainingIssues: [],
      }),
      providerName: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      pricingVerifiedAt: '2026-07-01',
      usage: { inputTokens: 300, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0.004,
    }),
    promptRegistry: {
      get: () => Promise.resolve(MOCK_PROMPT_SET),
    },
  };
}

function createState(): PipelineState {
  return {
    ...createInitialState(),
    draft: DRAFT,
    review: {
      technical: REVIEW,
      seo: REVIEW,
      loop: { iteration: 0 },
    },
  };
}

describe('qaModuleMetadata', () => {
  it('has the correct module key and dependencies', () => {
    expect(qaModuleMetadata.key).toBe('qa');
    expect(qaModuleMetadata.dependencies).toEqual([
      'humanizer',
      'reviewer-technical',
      'reviewer-seo',
    ]);
  });
});

describe('qaModule via the orchestrator binding', () => {
  it('writes qa.decision through the module runner', async () => {
    const services = createServices('needsRevision');
    const module = createQaModule();
    const registry = createModuleRegistry<QaModuleServices>().register(module);
    const state = createState();
    const binding = createQaModuleBinding();

    const input = binding.createInput(state, {} as never);
    const result = await new ModuleRunner({ registry, clock: new FakeClock() }).run(
      module,
      input as QaRequest,
      state,
      services,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newState = binding.applyOutput(state, result.output, {} as never);
    expect(newState.qa?.decision).toBe('needsRevision');
  });

  it('rejects a missing draft', () => {
    expect(() => buildQaRequest(createInitialState())).toThrow(ValidationError);
  });
});
