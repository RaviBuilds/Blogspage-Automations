import { describe, expect, it } from 'vitest';

import { FakeImageProvider } from '@/providers/image/FakeImageProvider.js';

function baseOptions() {
  return {
    moduleKey: 'image-generator',
    prompt: 'a hotel lobby',
    aspectRatio: '1:1',
  };
}

describe('FakeImageProvider', () => {
  it('defaults to a conservative capability set', () => {
    const provider = new FakeImageProvider();
    expect(provider.capabilities).toEqual({
      batchGeneration: false,
      editing: false,
      seeded: false,
    });
  });

  it('honors an explicit capabilities override', () => {
    const provider = new FakeImageProvider({
      capabilities: { batchGeneration: true, editing: true, seeded: true },
    });
    expect(provider.capabilities.editing).toBe(true);
  });

  it('returns the scripted data, mimeType, and cost', async () => {
    const provider = new FakeImageProvider({ data: 'YWJj', mimeType: 'image/webp', costUsd: 0.05 });

    const result = await provider.generate(baseOptions());

    expect(result).toEqual({
      data: 'YWJj',
      mimeType: 'image/webp',
      costUsd: 0.05,
      pricingVerifiedAt: '2026-01-01',
      providerName: 'fake',
      modelId: 'fake-image-model',
    });
  });

  it('defaults every unset result field to a neutral value', async () => {
    const provider = new FakeImageProvider();
    const result = await provider.generate(baseOptions());

    expect(result).toEqual({
      data: '',
      mimeType: 'image/png',
      costUsd: 0,
      pricingVerifiedAt: '2026-01-01',
      providerName: 'fake',
      modelId: 'fake-image-model',
    });
  });

  it('rejects with the scripted error when throws is set', async () => {
    const error = new Error('boom');
    const provider = new FakeImageProvider({ throws: error });

    await expect(provider.generate(baseOptions())).rejects.toBe(error);
  });

  it('records every call it receives, in order', async () => {
    const provider = new FakeImageProvider();
    const first = baseOptions();
    const second = { ...baseOptions(), prompt: 'a beach at sunset' };

    await provider.generate(first);
    await provider.generate(second);

    expect(provider.calls).toEqual([first, second]);
  });
});
