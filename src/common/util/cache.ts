/**
 * A small in-process TTL cache for hot, rarely-changing reads (settings,
 * categories, auth principals). Writers call `delete`/`clear` so a change made
 * through this instance is visible immediately.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expires: number }>();
  private readonly pending = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 5_000,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
    this.pending.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }

  /** Returns the cached value or loads it once, sharing the in-flight load. */
  async wrap(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const promise = load()
      .then((value) => {
        if (this.pending.get(key) === promise) this.set(key, value);
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
    this.pending.set(key, promise);
    return promise;
  }
}
