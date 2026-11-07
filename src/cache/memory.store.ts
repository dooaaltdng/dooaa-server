import { Logger } from '@nestjs/common';
import type { CacheStore } from './cache.store';

/** Kept small: the pxxl container has 512 MB, and the cache only saves database reads. */
const MAX_ENTRIES = 5_000;
const SWEEP_MS = 60_000;

/**
 * The cache when no Redis is configured: same contract, in process memory.
 * Fine for one running instance (DOOAA on pxxl); with several instances each
 * keeps its own copy, so set REDIS_URL before scaling out.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly logger = new Logger('Cache');
  private readonly entries = new Map<string, { value: string; expires: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.logger.log('Caching in memory (no Redis reachable; fine for a single instance)');
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

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
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + Math.max(1, ttlMs) });
    // Map keeps insertion order, so the first keys are the oldest writes.
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
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
    clearInterval(this.sweeper);
    this.entries.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }
}
