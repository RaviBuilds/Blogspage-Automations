import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '@/core/errors.js';

const generateMock = vi.fn();

class FakeAPIError extends Error {
  public constructor(public readonly status: number | undefined) {
    super('api error');
  }
}
class FakeAPIUserAbortError extends Error {}
class FakeAPIConnectionTimeoutError extends Error {}

vi.mock('openai', () => {
  class MockOpenAI {
    public images = { generate: generateMock };
    public static APIError = FakeAPIError;
    public static APIUserAbortError = FakeAPIUserAbortError;
    public static APIConnectionTimeoutError = FakeAPIConnectionTimeoutError;
  }
  return { default: MockOpenAI };
});

const { OpenAIImageProvider } = await import('@/providers/image/OpenAIImageProvider.js');

function baseOptions(overrides: Partial<Parameters<typeof provider.generate>[0]> = {}) {
  return {
    moduleKey: 'image-generator',
    prompt: 'a hotel lobby',
    aspectRatio: '1:1',
    ...overrides,
  };
}

let provider: InstanceType<typeof OpenAIImageProvider>;

beforeEach(() => {
  generateMock.mockReset();
  provider = new OpenAIImageProvider('gpt-image-1', 'test-key', 60_000);
});

describe('OpenAIImageProvider', () => {
  it('reports honest capabilities', () => {
    expect(provider.capabilities).toEqual({
      batchGeneration: true,
      editing: false,
      seeded: false,
    });
  });

  it('maps a successful response to ImageGenerateResult with cost', async () => {
    generateMock.mockResolvedValue({ data: [{ b64_json: 'YWJj' }] });

    const result = await provider.generate(baseOptions());

    expect(result.data).toBe('YWJj');
    expect(result.mimeType).toBe('image/png');
    expect(result.providerName).toBe('openai');
    expect(result.modelId).toBe('gpt-image-1');
    expect(result.costUsd).toBe(0.04);
  });

  it('charges the high-quality price when quality: high is requested', async () => {
    generateMock.mockResolvedValue({ data: [{ b64_json: 'YWJj' }] });

    const result = await provider.generate(baseOptions({ quality: 'high' }));
    expect(result.costUsd).toBe(0.08);
  });

  it('maps aspect ratio to the nearest supported size', async () => {
    generateMock.mockResolvedValue({ data: [{ b64_json: 'YWJj' }] });

    await provider.generate(baseOptions({ aspectRatio: '9:16' }));
    expect(generateMock.mock.calls[0]?.[0]).toMatchObject({ size: '1024x1536' });

    await provider.generate(baseOptions({ aspectRatio: '16:9' }));
    expect(generateMock.mock.calls[1]?.[0]).toMatchObject({ size: '1536x1024' });

    await provider.generate(baseOptions({ aspectRatio: '1:1' }));
    expect(generateMock.mock.calls[2]?.[0]).toMatchObject({ size: '1024x1024' });
  });

  it('passes an explicit size override through unchanged', async () => {
    generateMock.mockResolvedValue({ data: [{ b64_json: 'YWJj' }] });

    await provider.generate(baseOptions({ aspectRatio: '1:1', size: '1536x1024' }));
    expect(generateMock.mock.calls[0]?.[0]).toMatchObject({ size: '1536x1024' });
  });

  it('passes n through, defaulting to 1', async () => {
    generateMock.mockResolvedValue({ data: [{ b64_json: 'YWJj' }] });

    await provider.generate(baseOptions());
    expect(generateMock.mock.calls[0]?.[0]).toMatchObject({ n: 1 });

    await provider.generate(baseOptions({ n: 3 }));
    expect(generateMock.mock.calls[1]?.[0]).toMatchObject({ n: 3 });
  });

  it('passes the configured timeout to the SDK call, falling back to the default', async () => {
    generateMock.mockResolvedValue({ data: [{ b64_json: 'YWJj' }] });

    await provider.generate(baseOptions());
    expect(generateMock.mock.calls[0]?.[1]).toEqual({ timeout: 60_000 });

    await provider.generate(baseOptions({ timeoutMs: 5_000 }));
    expect(generateMock.mock.calls[1]?.[1]).toEqual({ timeout: 5_000 });
  });

  it('throws a non-retryable ProviderError when the response has no image data (malformed response)', async () => {
    generateMock.mockResolvedValue({ data: [{}] });

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      providerName: 'openai',
      retryable: false,
    });
  });

  it('throws a retryable ProviderError on a 429/5xx APIError', async () => {
    generateMock.mockRejectedValue(new FakeAPIError(500));

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'openai',
      statusCode: 500,
      retryable: true,
    });
    await expect(provider.generate(baseOptions())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a non-retryable ProviderError on a 401 APIError (invalid credentials)', async () => {
    generateMock.mockRejectedValue(new FakeAPIError(401));

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it('records health on success and failure', async () => {
    generateMock.mockResolvedValueOnce({ data: [{ b64_json: 'YWJj' }] });
    await provider.generate(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');

    generateMock.mockRejectedValueOnce(new FakeAPIError(500));
    await expect(provider.generate(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
  });
});
