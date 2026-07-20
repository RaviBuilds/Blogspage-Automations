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

vi.mock('openai', () => {
  class MockOpenAI {
    public chat = { completions: { create: createMock } };
    public static APIError = FakeAPIError;
    public static APIUserAbortError = FakeAPIUserAbortError;
    public static APIConnectionTimeoutError = FakeAPIConnectionTimeoutError;
  }
  return { default: MockOpenAI };
});

const { OpenAIProvider } = await import('@/providers/llm/OpenAIProvider.js');

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

let provider: InstanceType<typeof OpenAIProvider>;

beforeEach(() => {
  createMock.mockReset();
  provider = new OpenAIProvider('gpt-5.6-terra', 'test-key', 60_000);
});

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

describe('OpenAIProvider', () => {
  it('reports honest capabilities', () => {
    expect(provider.capabilities).toEqual({
      vision: true,
      jsonSchema: true,
      caching: true,
      reasoning: true,
    });
  });

  it('maps a successful response to LLMCallResult with cost and usage', async () => {
    createMock.mockResolvedValue(successResponse());

    const result = await provider.complete(baseOptions());

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      reasoningTokens: 0,
    });
    expect(result.stopReason).toBe('complete');
    expect(result.providerName).toBe('openai');
    expect(result.modelId).toBe('gpt-5.6-terra');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('extracts reasoning tokens from completion_tokens_details.reasoning_tokens', async () => {
    createMock.mockResolvedValue(
      successResponse({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    );

    const result = await provider.complete(baseOptions({ reasoningEffort: 'high' }));
    expect(result.usage.reasoningTokens).toBe(12);
  });

  it('sends reasoning_effort only when reasoningEffort is set to a non-none value', async () => {
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions({ reasoningEffort: 'medium' }));
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'medium' });

    await provider.complete(baseOptions());
    expect(createMock.mock.calls[1]?.[0]).not.toHaveProperty('reasoning_effort');

    await provider.complete(baseOptions({ reasoningEffort: 'none' }));
    expect(createMock.mock.calls[2]?.[0]).not.toHaveProperty('reasoning_effort');
  });

  it('requests json_schema structured output when a schema is supplied', async () => {
    createMock.mockResolvedValue(successResponse());

    await provider.complete(
      baseOptions({ responseFormat: 'json', jsonSchema: { type: 'object' } }),
    );

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'response', schema: { type: 'object' } },
      },
    });
  });

  it('falls back to json_object when responseFormat is json with no schema', async () => {
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions({ responseFormat: 'json' }));

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  it('omits response_format entirely for plain text calls', async () => {
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions());

    expect(createMock.mock.calls[0]?.[0]).not.toHaveProperty('response_format');
  });

  it('passes the configured timeout to the SDK call, falling back to the default', async () => {
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions());
    expect(createMock.mock.calls[0]?.[1]).toEqual({ timeout: 60_000 });

    await provider.complete(baseOptions({ timeoutMs: 5_000 }));
    expect(createMock.mock.calls[1]?.[1]).toEqual({ timeout: 5_000 });
  });

  it('builds multimodal content when images are supplied', async () => {
    createMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions({ images: [{ data: 'YWJj', mimeType: 'image/png' }] }));

    const messages = (createMock.mock.calls[0]?.[0] as { messages: unknown[] }).messages;
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'user' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
      ],
    });
  });

  it('maps length/content_filter finish reasons correctly', async () => {
    createMock.mockResolvedValueOnce(
      successResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }),
    );
    expect((await provider.complete(baseOptions())).stopReason).toBe('maxTokens');

    createMock.mockResolvedValueOnce(
      successResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }],
      }),
    );
    expect((await provider.complete(baseOptions())).stopReason).toBe('refusal');
  });

  it('throws a retryable ProviderError on a 429/5xx APIError', async () => {
    createMock.mockRejectedValue(new FakeAPIError(429));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'openai',
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

  it('handles a malformed response missing choices/usage gracefully', async () => {
    createMock.mockResolvedValue({ choices: [], usage: undefined });

    const result = await provider.complete(baseOptions());

    expect(result.text).toBe('');
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(result.stopReason).toBe('error');
  });

  it('records health on success and failure', async () => {
    createMock.mockResolvedValueOnce(successResponse());
    await provider.complete(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');

    createMock.mockRejectedValueOnce(new FakeAPIError(500));
    await expect(provider.complete(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
  });
});
