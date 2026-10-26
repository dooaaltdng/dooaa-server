import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CacheService } from './cache.service';
import { CACHE_STORE, type CacheStore } from './cache.store';
import { RedisCacheStore } from './redis.store';

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

/** Redis-backed caching, available everywhere as `CacheService`. */
@Global()
@Module({
  providers: [
    {
      provide: CACHE_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): CacheStore => new RedisCacheStore(config.redis.url, config.redis.keyPrefix),
    },
    CacheService,
    CacheLifecycle,
  ],
  exports: [CacheService],
})
export class CacheModule {}
