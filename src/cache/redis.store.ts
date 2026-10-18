import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { CacheStore } from './cache.store';

/**
 * The Redis-backed cache store. Commands fail fast while Redis is
 * unreachable (no offline queue), so a Redis outage turns into cache misses
 * instead of hung requests; ioredis keeps reconnecting in the background.
 */
export class RedisCacheStore implements CacheStore {
  private readonly logger = new Logger('Redis');
  private readonly client: Redis;
  private lastErrorLog = 0;

  constructor(url: string, keyPrefix: string) {
    this.client = new Redis(url, {
      keyPrefix,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    });
    this.client.on('error', (error: Error) => this.logError(`Redis error: ${error.message}`));
    this.client.on('ready', () => this.logger.log('Connected to Redis'));
  }

  /** Connects at boot. A failure is logged, not thrown: the app serves from the database meanwhile. */
  async connect(): Promise<void> {
    await this.client.connect().catch((error: Error) => this.logError(`Redis unavailable, caching is off until it reconnects: ${error.message}`));
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)));
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.client.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)), 'NX')) === 'OK';
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  async ping(): Promise<boolean> {
    return this.client
      .ping()
      .then((reply) => reply === 'PONG')
      .catch(() => false);
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }

  /** At most one line a minute while Redis is down. */
  private logError(message: string): void {
    if (Date.now() - this.lastErrorLog < 60_000) return;
    this.lastErrorLog = Date.now();
    this.logger.error(message);
  }
}
