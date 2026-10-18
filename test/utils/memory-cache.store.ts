import type { CacheStore } from '../../src/cache/cache.store';

/** The test suite's Redis: same contract, kept in process memory. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expires: number }>();

  async get(key: string): Promise<string | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if ((await this.get(key)) !== null) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}
