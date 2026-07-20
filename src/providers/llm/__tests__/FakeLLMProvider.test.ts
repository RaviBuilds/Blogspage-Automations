import { describe, expect, it } from 'vitest';

import { FakeLLMProvider } from '@/providers/llm/FakeLLMProvider.js';

function baseOptions() {
  return {
    moduleKey: 'writer',
    systemPrompt: 'system',
    userPrompt: 'user',
    responseFormat: 'text' as const,
    maxOutputTokens: 100,
  };
}

describe('FakeLLMProvider', () => {
  it('defaults to a conservative capability set', () => {
    const provider = new FakeLLMProvider();
    expect(provider.capabilities).toEqual({
      vision: false,
      jsonSchema: true,
      caching: false,
      reasoning: false,
    });
  });

  it('honors an explicit capabilities override', () => {
    const provider = new FakeLLMProvider({
      capabilities: { vision: true, jsonSchema: true, caching: true, reasoning: true },
    });
    expect(provider.capabilities.vision).toBe(true);
    expect(provider.capabilities.reasoning).toBe(true);
  });

  it('returns the scripted text, usage, cost, and stopReason', async () => {
    const provider = new FakeLLMProvider({
      text: 'Hello',
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5, reasoningTokens: 2 },
      costUsd: 0.01,
      stopReason: 'maxTokens',
    });

    const result = await provider.complete(baseOptions());

    expect(result).toEqual({
      text: 'Hello',
      usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5, reasoningTokens: 2 },
      costUsd: 0.01,
      pricingVerifiedAt: '2026-01-01',
      providerName: 'fake',
      modelId: 'fake-model',
      stopReason: 'maxTokens',
    });
  });

  it('defaults every unset result field to a neutral value', async () => {
    const provider = new FakeLLMProvider();
    const result = await provider.complete(baseOptions());

    expect(result).toEqual({
      text: '',
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      costUsd: 0,
      pricingVerifiedAt: '2026-01-01',
      providerName: 'fake',
      modelId: 'fake-model',
      stopReason: 'complete',
    });
  });

  it('rejects with the scripted error when throws is set', async () => {
    const error = new Error('boom');
    const provider = new FakeLLMProvider({ throws: error });

    await expect(provider.complete(baseOptions())).rejects.toBe(error);
  });

  it('records every call it receives, in order', async () => {
    const provider = new FakeLLMProvider();
    const first = baseOptions();
    const second = { ...baseOptions(), moduleKey: 'humanizer' };

    await provider.complete(first);
    await provider.complete(second);

    expect(provider.calls).toEqual([first, second]);
  });
});
