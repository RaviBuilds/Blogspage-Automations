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

const { LocalLLMProvider } = await import('@/providers/llm/LocalLLMProvider.js');

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

let provider: InstanceType<typeof LocalLLMProvider>;

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
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

describe('LocalLLMProvider', () => {
  it('resolves known capabilities from the model lookup table', () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    expect(provider.capabilities).toEqual({
      vision: false,
      jsonSchema: true,
      caching: false,
      reasoning: false,
    });
  });

  it('falls back to the most conservative capabilities for an unrecognized model', () => {
    provider = new LocalLLMProvider('some-unknown-model', 'http://localhost:11434', 180_000);
    expect(provider.capabilities).toEqual({
      vision: false,
      jsonSchema: false,
      caching: false,
      reasoning: false,
    });
  });

  it('constructs the OpenAI-compatible client pointed at the configured local endpoint', () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    expect(constructorSpy).toHaveBeenCalledWith({
      apiKey: 'local',
      baseURL: 'http://localhost:11434',
    });
  });

  it('maps a successful response to LLMCallResult with zero cost (no pricing table)', async () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    createMock.mockResolvedValue(successResponse());

    const result = await provider.complete(baseOptions());

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(result.costUsd).toBe(0);
    expect(result.providerName).toBe('local');
    expect(result.stopReason).toBe('complete');
  });

  it('passes the configured timeout to the SDK call, falling back to the higher local default', async () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions());
    expect(createMock.mock.calls[0]?.[1]).toEqual({ timeout: 180_000 });

    await provider.complete(baseOptions({ timeoutMs: 5_000 }));
    expect(createMock.mock.calls[1]?.[1]).toEqual({ timeout: 5_000 });
  });

  it('throws a retryable ProviderError on a 429/5xx APIError', async () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    createMock.mockRejectedValue(new FakeAPIError(503));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'local',
      statusCode: 503,
      retryable: true,
    });
    await expect(provider.complete(baseOptions())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a retryable ProviderError with no status on a connection timeout', async () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    createMock.mockRejectedValue(new FakeAPIConnectionTimeoutError('timed out'));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: undefined,
      retryable: true,
    });
  });

  it('records health on success and failure', async () => {
    provider = new LocalLLMProvider('llama-3.1-70b-instruct', 'http://localhost:11434', 180_000);
    createMock.mockResolvedValueOnce(successResponse());
    await provider.complete(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');

    createMock.mockRejectedValueOnce(new FakeAPIError(500));
    await expect(provider.complete(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
  });
});
