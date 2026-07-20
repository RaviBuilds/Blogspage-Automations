import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '@/core/errors.js';

const createMock = vi.fn();
const constructorSpy = vi.fn();

class FakeAPIError extends Error {
  public constructor(public readonly status: number | undefined) {
    super('api error');
  }
}
class FakeAPIUserAbortError extends Error {}
class FakeAPIConnectionTimeoutError extends Error {}

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: createMock } };
    public static APIError = FakeAPIError;
    public static APIUserAbortError = FakeAPIUserAbortError;
    public static APIConnectionTimeoutError = FakeAPIConnectionTimeoutError;
    public constructor(options: unknown) {
      constructorSpy(options);
    }
  }
  return { default: MockOpenAI };
});

const { OpenRouterProvider } = await import('@/providers/llm/OpenRouterProvider.js');

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

let provider: InstanceType<typeof OpenRouterProvider>;

beforeEach(() => {
  createMock.mockReset();
  constructorSpy.mockReset();
});

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 0 },
      cost: 0.0042,
    },
    ...overrides,
  };
}

describe('OpenRouterProvider', () => {
  it('resolves known capabilities from the model lookup table', () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'key', 60_000);
    expect(provider.capabilities).toEqual({
      vision: true,
      jsonSchema: true,
      caching: true,
      reasoning: false,
    });
  });

  it('falls back to the most conservative capabilities for an unrecognized model', () => {
    provider = new OpenRouterProvider('some/unknown-model', 'key', 60_000);
    expect(provider.capabilities).toEqual({
      vision: false,
      jsonSchema: false,
      caching: false,
      reasoning: false,
    });
  });

  it('constructs the OpenAI-compatible client pointed at the OpenRouter base URL', () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'my-key', 60_000);
    expect(constructorSpy).toHaveBeenCalledWith({
      apiKey: 'my-key',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });

  it('maps a successful response to LLMCallResult, using usage.cost as the authoritative cost', async () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'key', 60_000);
    createMock.mockResolvedValue(successResponse());

    const result = await provider.complete(baseOptions());

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      reasoningTokens: 0,
    });
    expect(result.costUsd).toBe(0.0042);
    expect(result.providerName).toBe('openrouter');
    expect(result.stopReason).toBe('complete');
  });

  it('extracts reasoning tokens from completion_tokens_details.reasoning_tokens', async () => {
    provider = new OpenRouterProvider('openai/gpt-5.6-terra', 'key', 60_000);
    createMock.mockResolvedValue(
      successResponse({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 8 },
          cost: 0.001,
        },
      }),
    );

    const result = await provider.complete(baseOptions());
    expect(result.usage.reasoningTokens).toBe(8);
  });

  it('passes the configured timeout to the SDK call, falling back to the default', async () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'key', 60_000);
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions());
    expect(createMock.mock.calls[0]?.[1]).toEqual({ timeout: 60_000 });

    await provider.complete(baseOptions({ timeoutMs: 5_000 }));
    expect(createMock.mock.calls[1]?.[1]).toEqual({ timeout: 5_000 });
  });

  it('throws a retryable ProviderError on a 429/5xx APIError', async () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'key', 60_000);
    createMock.mockRejectedValue(new FakeAPIError(429));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'openrouter',
      statusCode: 429,
      retryable: true,
    });
    await expect(provider.complete(baseOptions())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a non-retryable ProviderError on a 401 APIError (invalid credentials)', async () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'key', 60_000);
    createMock.mockRejectedValue(new FakeAPIError(401));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it('records health on success and failure', async () => {
    provider = new OpenRouterProvider('anthropic/claude-sonnet-5', 'key', 60_000);
    createMock.mockResolvedValueOnce(successResponse());
    await provider.complete(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');

    createMock.mockRejectedValueOnce(new FakeAPIError(500));
    await expect(provider.complete(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
  });
});
