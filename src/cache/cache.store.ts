/**
 * Where cached values live: Redis in every running environment, memory in
 * the test suite. Values are opaque strings; CacheService does the encoding.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Sets the key only if it is absent; true when this call set it. Atomic across instances. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  delete(keys: string[]): Promise<void>;
  /** True when the store answers. Used by the health check. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const CACHE_STORE = Symbol('CACHE_STORE');
