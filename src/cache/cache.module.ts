import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CacheService } from './cache.service';
import { CACHE_STORE, type CacheStore } from './cache.store';
import { MemoryCacheStore } from './memory.store';
import { RedisCacheStore } from './redis.store';

/** A usable Redis address, not empty or a placeholder like "to-be-updated". */
function isRedisUrl(url: string): boolean {
  return /^rediss?:\/\/\S+/.test(url.trim());
}

@Injectable()
class CacheLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(CACHE_STORE) private readonly store: CacheStore) {}

  async onModuleInit(): Promise<void> {
    if (this.store instanceof RedisCacheStore) await this.store.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.store.close();
  }
}

/** Caching, available everywhere as `CacheService`: Redis when REDIS_URL is set, memory otherwise. */
@Global()
@Module({
  providers: [
    {
      provide: CACHE_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): CacheStore =>
        isRedisUrl(config.redis.url) ? new RedisCacheStore(config.redis.url.trim(), config.redis.keyPrefix) : new MemoryCacheStore(),
    },
    CacheService,
    CacheLifecycle,
  ],
  exports: [CacheService],
})
export class CacheModule {}
