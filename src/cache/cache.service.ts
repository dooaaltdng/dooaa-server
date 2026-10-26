import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_STORE, type CacheStore } from './cache.store';
import { explain } from '../common/util/explain-error';

const DATE_TAG = '$date';

/** JSON that survives a round trip with its Dates intact. */
export function encodeValue(value: unknown): string {
  return JSON.stringify(value ?? null, function (this: Record<string, unknown>, key, current: unknown) {
    const raw = this[key];
    return raw instanceof Date ? { [DATE_TAG]: raw.toISOString() } : current;
  });
}

export function decodeValue<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const tagged = (value as Record<string, unknown>)[DATE_TAG];
      if (typeof tagged === 'string' && Object.keys(value).length === 1) return new Date(tagged);
    }
    return value;
  }) as T;
}

/**
 * Shared, cross-instance caching for hot reads that change rarely
 * (settings, categories, signed-in principals, the homepage rails).
 * Writers delete the keys they affect, so every instance sees a change on
 * its next read. The cache is an optimisation only: when the store fails,
 * reads fall through to the loader and writes are skipped.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger('Cache');
  /** Loads in progress on this instance, so a burst of misses costs one load. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private lastWarning = 0;

  constructor(@Inject(CACHE_STORE) private readonly store: CacheStore) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const text = await this.store.get(key);
      return text === null ? undefined : decodeValue<T>(text);
    } catch (error) {
      this.warn(`read ${key}`, error);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      await this.store.set(key, encodeValue(value), ttlMs);
    } catch (error) {
      this.warn(`write ${key}`, error);
    }
  }

  /**
   * Claims a key for `ttlMs`, once across every instance: true for the first
   * caller, false while the claim lasts. Used for cooldowns. When the store
   * is unreachable the claim is granted, so the work still happens.
   */
  async claim(key: string, ttlMs: number): Promise<boolean> {
    try {
      return await this.store.setIfAbsent(key, '1', ttlMs);
    } catch (error) {
      this.warn(`claim ${key}`, error);
      return true;
    }
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) this.inflight.delete(key);
    try {
      await this.store.delete(keys);
    } catch (error) {
      this.warn(`delete ${keys.join(', ')}`, error);
    }
  }

  /** The cached value, or the loader's result (cached for `ttlMs`). Concurrent misses share one load. */
  async wrap<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = load().then(async (value) => {
      if (this.inflight.get(key) === promise) await this.set(key, value, ttlMs);
      return value;
    });
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    }
  }

  ping(): Promise<boolean> {
    return this.store.ping();
  }

  private warn(action: string, error: unknown): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(explain(`Could not ${action} the cache, so the database was used instead`, error));
  }
}
