import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { CacheService } from '../../cache/cache.service';
import { Public } from '../../common/auth/decorators';
import { InjectDb, type Database } from '../../database/database';

const startedAt = Date.now();

/** Resolves to the fallback when a check takes too long, so the health route always answers quickly. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())]);
}

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly cache: CacheService,
  ) {}

  /**
   * Liveness and dependencies. PostgreSQL is required: without it the
   * status is "degraded". Redis is a cache, so its outage is reported but
   * the API keeps serving from the database.
   */
  @Public()
  @Get()
  async health() {
    const [dbUp, cacheUp] = await Promise.all([
      within(
        this.db.execute(sql`select 1`).then(() => true),
        3_000,
        false,
      ),
      within(this.cache.ping(), 3_000, false),
    ]);
    return {
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? 'up' : 'down',
      cache: cacheUp ? 'up' : 'down',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }
}
