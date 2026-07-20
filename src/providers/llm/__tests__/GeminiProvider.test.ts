import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '@/core/errors.js';

const generateContentMock = vi.fn();

class FakeApiError extends Error {
  public constructor(public readonly status: number | undefined) {
    super('api error');
  }
}

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    public models = { generateContent: generateContentMock };
  }
  return { GoogleGenAI: MockGoogleGenAI, ApiError: FakeApiError };
});

const { GeminiProvider } = await import('@/providers/llm/GeminiProvider.js');

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

let provider: InstanceType<typeof GeminiProvider>;

beforeEach(() => {
  generateContentMock.mockReset();
  provider = new GeminiProvider('gemini-2.5-pro', 'test-key', 60_000);
});

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    text: 'Hello world',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 10,
      thoughtsTokenCount: 0,
    },
    ...overrides,
  };
}

describe('GeminiProvider', () => {
  it('reports honest capabilities', () => {
    expect(provider.capabilities).toEqual({
      vision: true,
      jsonSchema: true,
      caching: true,
      reasoning: true,
    });
  });

  it('maps a successful response to LLMCallResult with cost and usage', async () => {
    generateContentMock.mockResolvedValue(successResponse());

    const result = await provider.complete(baseOptions());

    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      reasoningTokens: 0,
    });
    expect(result.stopReason).toBe('complete');
    expect(result.providerName).toBe('gemini');
    expect(result.modelId).toBe('gemini-2.5-pro');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('extracts reasoning tokens from usageMetadata.thoughtsTokenCount', async () => {
    generateContentMock.mockResolvedValue(
      successResponse({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 0,
          thoughtsTokenCount: 15,
        },
      }),
    );

    const result = await provider.complete(baseOptions({ reasoningEffort: 'high' }));
    expect(result.usage.reasoningTokens).toBe(15);
  });

  it('sends a thinkingConfig only when reasoningEffort is set to a non-none value', async () => {
    generateContentMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions({ reasoningEffort: 'medium' }));
    expect(generateContentMock.mock.calls[0]?.[0]).toMatchObject({
      config: { thinkingConfig: { includeThoughts: false, thinkingBudget: 8_192 } },
    });

    await provider.complete(baseOptions());
    expect(generateContentMock.mock.calls[1]?.[0]).not.toHaveProperty('config.thinkingConfig');

    await provider.complete(baseOptions({ reasoningEffort: 'none' }));
    expect(generateContentMock.mock.calls[2]?.[0]).not.toHaveProperty('config.thinkingConfig');
  });

  it('requests responseSchema and responseMimeType for JSON calls', async () => {
    generateContentMock.mockResolvedValue(successResponse());

    await provider.complete(
      baseOptions({ responseFormat: 'json', jsonSchema: { type: 'object' } }),
    );

    expect(generateContentMock.mock.calls[0]?.[0]).toMatchObject({
      config: { responseMimeType: 'application/json', responseSchema: { type: 'object' } },
    });
  });

  it('passes the configured timeout via httpOptions, falling back to the default', async () => {
    generateContentMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions());
    expect(generateContentMock.mock.calls[0]?.[0]).toMatchObject({
      config: { httpOptions: { timeout: 60_000 } },
    });

    await provider.complete(baseOptions({ timeoutMs: 5_000 }));
    expect(generateContentMock.mock.calls[1]?.[0]).toMatchObject({
      config: { httpOptions: { timeout: 5_000 } },
    });
  });

  it('builds multimodal content when images are supplied', async () => {
    generateContentMock.mockResolvedValue(successResponse());

    await provider.complete(baseOptions({ images: [{ data: 'YWJj', mimeType: 'image/png' }] }));

    const contents = (generateContentMock.mock.calls[0]?.[0] as { contents: unknown[] }).contents;
    expect(contents[0]).toMatchObject({
      role: 'user',
      parts: [{ text: 'user' }, { inlineData: { data: 'YWJj', mimeType: 'image/png' } }],
    });
  });

  it('maps MAX_TOKENS/SAFETY/RECITATION finish reasons correctly', async () => {
    generateContentMock.mockResolvedValueOnce(
      successResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
    );
    expect((await provider.complete(baseOptions())).stopReason).toBe('maxTokens');

    generateContentMock.mockResolvedValueOnce(
      successResponse({ candidates: [{ finishReason: 'SAFETY' }] }),
    );
    expect((await provider.complete(baseOptions())).stopReason).toBe('refusal');

    generateContentMock.mockResolvedValueOnce(
      successResponse({ candidates: [{ finishReason: 'RECITATION' }] }),
    );
    expect((await provider.complete(baseOptions())).stopReason).toBe('refusal');
  });

  it('throws a retryable ProviderError on a 429/5xx ApiError', async () => {
    generateContentMock.mockRejectedValue(new FakeApiError(429));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'gemini',
      statusCode: 429,
      retryable: true,
    });
    await expect(provider.complete(baseOptions())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a non-retryable ProviderError on a 401 ApiError (invalid credentials)', async () => {
    generateContentMock.mockRejectedValue(new FakeApiError(401));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it('throws a retryable ProviderError with no status on an unknown error', async () => {
    generateContentMock.mockRejectedValue(new Error('network blip'));

    await expect(provider.complete(baseOptions())).rejects.toMatchObject({
      statusCode: undefined,
      retryable: true,
    });
  });

  it('handles a malformed response missing usageMetadata/candidates gracefully', async () => {
    generateContentMock.mockResolvedValue({
      text: undefined,
      candidates: undefined,
      usageMetadata: undefined,
    });

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
    generateContentMock.mockResolvedValueOnce(successResponse());
    await provider.complete(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');

    generateContentMock.mockRejectedValueOnce(new FakeApiError(500));
    await expect(provider.complete(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
  });
});
