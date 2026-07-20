import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '@/core/errors.js';

const createMock = vi.fn();

class FakeAPIError extends Error {
  public constructor(public readonly status: number | undefined) {
    super('api error');
  }
}
class FakeAPIUserAbortError extends Error {}
class FakeAPIConnectionTimeoutError extends Error {}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    public messages = { create: createMock };
    public static APIError = FakeAPIError;
    public static APIUserAbortError = FakeAPIUserAbortError;
    public static APIConnectionTimeoutError = FakeAPIConnectionTimeoutError;
  }
  return { default: MockAnthropic };
});

const { AnthropicProvider } = await import('@/providers/llm/AnthropicProvider.js');

function baseOptions(overrides: Partial<Parameters<typeof provider.complete>[0]> = {}) {
  return {
    moduleKey: 'writer',
    systemPrompt: 'system',
    userPrompt: 'user',
    responseFormat: 'text' as const,
    maxOutputTokens: 100,
    ...overrides,
  };
}

let provider: InstanceType<typeof AnthropicProvider>;

beforeEach(() => {
  createMock.mockReset();
  provider = new AnthropicProvider('claude-sonnet-5', 'test-key', 60_000);
});

describe('AnthropicProvider', () => {
  it('reports honest capabilities', () => {
    expect(provider.capabilities).toEqual({
      vision: true,
      jsonSchema: true,
      caching: true,
      reasoning: true,
    });
  });

  it('maps a successful response to LLMCallResult with cost and usage', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello world' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        output_tokens_details: null,
      },
      stop_reason: 'end_turn',
    });

    const result = await provider.complete(baseOptions());

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      reasoningTokens: 0,
    });
    expect(result.stopReason).toBe('complete');
    expect(result.providerName).toBe('anthropic');
    expect(result.modelId).toBe('claude-sonnet-5');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('extracts reasoning tokens from output_tokens_details.thinking_tokens', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'Answer' }],
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 15 },
      },
      stop_reason: 'end_turn',
    });

    const result = await provider.complete(baseOptions({ reasoningEffort: 'high' }));

    expect(result.usage.reasoningTokens).toBe(15);
  });

  it('sends a thinking config only when reasoningEffort is set', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens_details: null,
      },
      stop_reason: 'end_turn',
    });

    await provider.complete(baseOptions({ reasoningEffort: 'medium' }));
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 8_192 },
    });

    await provider.complete(baseOptions());
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('thinking');
  });

  it('applies an ephemeral cache_control marker when cacheableSystemPromptPrefix is true', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens_details: null,
      },
      stop_reason: 'end_turn',
    });

    await provider.complete(baseOptions({ cacheableSystemPromptPrefix: true }));

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('passes the configured timeout to the SDK call, falling back to the default', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens_details: null,
      },
      stop_reason: 'end_turn',
    });

    await provider.complete(baseOptions());
    expect(createMock.mock.calls[0]?.[1]).toEqual({ timeout: 60_000 });

    await provider.complete(baseOptions({ timeoutMs: 5_000 }));
    expect(createMock.mock.calls[1]?.[1]).toEqual({ timeout: 5_000 });
  });

  it('maps max_tokens/refusal stop reasons correctly', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens_details: null,
      },
      stop_reason: 'max_tokens',
    });
    expect((await provider.complete(baseOptions())).stopReason).toBe('maxTokens');

    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens_details: null,
      },
      stop_reason: 'refusal',
    });
    expect((await provider.complete(baseOptions())).stopReason).toBe('refusal');
  });

  it('throws a retryable ProviderError on a 429/5xx APIError', async () => {
    createMock.mockRejectedValue(new FakeAPIError(429));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'anthropic',
      statusCode: 429,
      retryable: true,
    });
    await expect(provider.complete(baseOptions())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a non-retryable ProviderError on a 401 APIError (invalid credentials)', async () => {
    createMock.mockRejectedValue(new FakeAPIError(401));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it('throws a retryable ProviderError with no status on a timeout/abort', async () => {
    createMock.mockRejectedValue(new FakeAPIConnectionTimeoutError('timed out'));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: undefined,
      retryable: true,
    });
  });

  it('throws a retryable ProviderError with no status on an unknown error', async () => {
    createMock.mockRejectedValue(new Error('network blip'));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: undefined,
      retryable: true,
    });
  });

  it('records health on success and failure', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens_details: null,
      },
      stop_reason: 'end_turn',
    });
    await provider.complete(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');
    expect(provider.getStatus().lastSuccessAt).toBeDefined();

    createMock.mockRejectedValueOnce(new FakeAPIError(500));
    await expect(provider.complete(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
    expect(provider.getStatus().lastFailureAt).toBeDefined();
  });
});
