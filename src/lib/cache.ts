/**
 * A minimal process-lifetime cache for asynchronous loads, keyed by string.
 *
 * Concurrent requests for the same key share a single in-flight load rather
 * than triggering redundant work. A rejected load is evicted immediately so a
 * transient failure (for example, a momentarily locked file) does not
 * permanently poison the cache entry.
 */
export class AsyncCache<Value> {
  private readonly entries = new Map<string, Promise<Value>>();

  /** True when a resolved or in-flight entry already exists for this key. */
  public has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Returns the cached value for `key`, loading it with `load` on a cache
   * miss. The in-flight promise is cached immediately so simultaneous callers
   * share one load rather than issuing duplicate work.
   */
  public async getOrLoad(key: string, load: () => Promise<Value>): Promise<Value> {
    const existing = this.entries.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const pending = load().catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });

    this.entries.set(key, pending);
    return pending;
  }

  /** Removes one cached entry, forcing the next load to hit the source again. */
  public delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Removes every cached entry. */
  public clear(): void {
    this.entries.clear();
  }

  /** The number of resolved or in-flight entries currently cached. */
  public get size(): number {
    return this.entries.size;
  }
}
