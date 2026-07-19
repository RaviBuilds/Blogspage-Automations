import { describe, expect, it, vi } from 'vitest';

import { AsyncCache } from '@/lib/cache.js';

describe('AsyncCache', () => {
  it('loads a value on first access and reuses it on subsequent access', async () => {
    const cache = new AsyncCache<string>();
    const load = vi.fn().mockResolvedValue('value-a');

    const first = await cache.getOrLoad('key-a', load);
    const second = await cache.getOrLoad('key-a', load);

    expect(first).toBe('value-a');
    expect(second).toBe('value-a');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight load across concurrent requests for the same key', async () => {
    const cache = new AsyncCache<string>();
    let resolveLoad: (value: string) => void = () => {
      throw new Error('resolveLoad was not assigned');
    };
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const first = cache.getOrLoad('key-a', load);
    const second = cache.getOrLoad('key-a', load);

    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad('shared-value');

    await expect(first).resolves.toBe('shared-value');
    await expect(second).resolves.toBe('shared-value');
  });

  it('evicts a rejected load so the next request retries instead of caching the failure', async () => {
    const cache = new AsyncCache<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce('recovered-value');

    await expect(cache.getOrLoad('key-a', load)).rejects.toThrow('transient failure');
    expect(cache.has('key-a')).toBe(false);

    const recovered = await cache.getOrLoad('key-a', load);

    expect(recovered).toBe('recovered-value');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps independent cache entries per key', async () => {
    const cache = new AsyncCache<string>();

    await cache.getOrLoad('key-a', () => Promise.resolve('value-a'));
    await cache.getOrLoad('key-b', () => Promise.resolve('value-b'));

    expect(cache.size).toBe(2);
    expect(cache.has('key-a')).toBe(true);
    expect(cache.has('key-b')).toBe(true);
  });

  it('delete() forces the next load to hit the source again', async () => {
    const cache = new AsyncCache<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first-value')
      .mockResolvedValueOnce('second-value');

    await cache.getOrLoad('key-a', load);
    cache.delete('key-a');
    const second = await cache.getOrLoad('key-a', load);

    expect(second).toBe('second-value');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('clear() removes every cached entry', async () => {
    const cache = new AsyncCache<string>();

    await cache.getOrLoad('key-a', () => Promise.resolve('value-a'));
    await cache.getOrLoad('key-b', () => Promise.resolve('value-b'));
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.has('key-a')).toBe(false);
    expect(cache.has('key-b')).toBe(false);
  });
});
