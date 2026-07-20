import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderError } from '@/core/errors.js';

const generateImagesMock = vi.fn();

class FakeApiError extends Error {
  public constructor(public readonly status: number | undefined) {
    super('api error');
  }
}

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    public models = { generateImages: generateImagesMock };
  }
  return { GoogleGenAI: MockGoogleGenAI, ApiError: FakeApiError };
});

const { GeminiImageProvider } = await import('@/providers/image/GeminiImageProvider.js');

function baseOptions(overrides: Partial<Parameters<typeof provider.generate>[0]> = {}) {
  return {
    moduleKey: 'image-generator',
    prompt: 'a hotel lobby',
    aspectRatio: '1:1',
    ...overrides,
  };
}

let provider: InstanceType<typeof GeminiImageProvider>;

beforeEach(() => {
  generateImagesMock.mockReset();
  provider = new GeminiImageProvider('imagen-4-standard', 'test-key', 60_000);
});

describe('GeminiImageProvider', () => {
  it('reports honest capabilities', () => {
    expect(provider.capabilities).toEqual({
      batchGeneration: true,
      editing: false,
      seeded: true,
    });
  });

  it('maps a successful response to ImageGenerateResult with cost', async () => {
    generateImagesMock.mockResolvedValue({
      generatedImages: [{ image: { imageBytes: 'YWJj', mimeType: 'image/png' } }],
    });

    const result = await provider.generate(baseOptions());

    expect(result.data).toBe('YWJj');
    expect(result.mimeType).toBe('image/png');
    expect(result.providerName).toBe('gemini');
    expect(result.modelId).toBe('imagen-4-standard');
    expect(result.costUsd).toBe(0.04);
  });

  it('uses the per-model price for a different configured model', async () => {
    provider = new GeminiImageProvider('imagen-4-ultra', 'test-key', 60_000);
    generateImagesMock.mockResolvedValue({
      generatedImages: [{ image: { imageBytes: 'YWJj', mimeType: 'image/png' } }],
    });

    const result = await provider.generate(baseOptions());
    expect(result.costUsd).toBe(0.06);
  });

  it('passes seed through only when supplied', async () => {
    generateImagesMock.mockResolvedValue({
      generatedImages: [{ image: { imageBytes: 'YWJj', mimeType: 'image/png' } }],
    });

    await provider.generate(baseOptions());
    expect(generateImagesMock.mock.calls[0]?.[0]).not.toHaveProperty('config.seed');

    await provider.generate(baseOptions({ seed: 42 }));
    expect(generateImagesMock.mock.calls[1]?.[0]).toMatchObject({ config: { seed: 42 } });
  });

  it('passes numberOfImages through, defaulting to 1', async () => {
    generateImagesMock.mockResolvedValue({
      generatedImages: [{ image: { imageBytes: 'YWJj', mimeType: 'image/png' } }],
    });

    await provider.generate(baseOptions());
    expect(generateImagesMock.mock.calls[0]?.[0]).toMatchObject({ config: { numberOfImages: 1 } });

    await provider.generate(baseOptions({ n: 4 }));
    expect(generateImagesMock.mock.calls[1]?.[0]).toMatchObject({ config: { numberOfImages: 4 } });
  });

  it('passes the configured timeout via httpOptions, falling back to the default', async () => {
    generateImagesMock.mockResolvedValue({
      generatedImages: [{ image: { imageBytes: 'YWJj', mimeType: 'image/png' } }],
    });

    await provider.generate(baseOptions());
    expect(generateImagesMock.mock.calls[0]?.[0]).toMatchObject({
      config: { httpOptions: { timeout: 60_000 } },
    });

    await provider.generate(baseOptions({ timeoutMs: 5_000 }));
    expect(generateImagesMock.mock.calls[1]?.[0]).toMatchObject({
      config: { httpOptions: { timeout: 5_000 } },
    });
  });

  it('throws a non-retryable ProviderError when the response has no image data (malformed response)', async () => {
    generateImagesMock.mockResolvedValue({ generatedImages: [] });

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      providerName: 'gemini',
      retryable: false,
    });
  });

  it('throws a retryable ProviderError on a 429/5xx ApiError', async () => {
    generateImagesMock.mockRejectedValue(new FakeApiError(500));

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      name: 'ProviderError',
      providerName: 'gemini',
      statusCode: 500,
      retryable: true,
    });
    await expect(provider.generate(baseOptions())).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws a non-retryable ProviderError on a 401 ApiError (invalid credentials)', async () => {
    generateImagesMock.mockRejectedValue(new FakeApiError(401));

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      statusCode: 401,
      retryable: false,
    });
  });

  it('throws a retryable ProviderError with no status on an unknown error', async () => {
    generateImagesMock.mockRejectedValue(new Error('network blip'));

    await expect(provider.generate(baseOptions())).rejects.toMatchObject({
      statusCode: undefined,
      retryable: true,
    });
  });

  it('records health on success and failure', async () => {
    generateImagesMock.mockResolvedValueOnce({
      generatedImages: [{ image: { imageBytes: 'YWJj', mimeType: 'image/png' } }],
    });
    await provider.generate(baseOptions());
    expect(provider.getStatus().health).toBe('healthy');

    generateImagesMock.mockRejectedValueOnce(new FakeApiError(500));
    await expect(provider.generate(baseOptions())).rejects.toThrow();
    expect(provider.getStatus().consecutiveFailures).toBe(1);
  });
});
