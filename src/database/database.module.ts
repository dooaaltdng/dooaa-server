import { Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgSequence } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DATABASE, InjectDb, PG_POOL, type Database } from './database';
import { pendingMigrations } from './migrations';
import * as schema from './schema';

export function createPool(config: AppConfig['database']): Pool {
  return new Pool({
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: config.statementTimeoutMs,
    application_name: 'dooaa-server',
  });
}

export function createDatabase(pool: Pool): Database {
  return drizzle({ client: pool, schema, casing: 'snake_case' });
}

/** Next value of a Postgres sequence (dispute and support ticket numbers). */
@Injectable()
export class SequencesService {
  constructor(@InjectDb() private readonly db: Database) {}

  async next(sequence: PgSequence): Promise<number> {
    const result = await this.db.execute<{ value: string }>(sql`select nextval(${sequence.seqName}::regclass) as value`);
    return Number(result.rows[0].value);
  }
}

/**
 * Connects before the app serves anything, refuses to start on a schema that
 * is behind the code, and closes the pool on shutdown. Migrations are applied
 * by `npm run db:migrate` as a release step, never by the app itself.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @InjectDb() private readonly db: Database,
  ) {
    // An idle client losing its connection must not take the process down; the pool replaces it.
    this.pool.on('error', (error) => this.logger.error(`Idle database connection failed: ${error.message}`));
  }

  async onApplicationBootstrap(): Promise<void> {
    const started = Date.now();
    await this.pool.query('select 1');
    const pending = await pendingMigrations(this.db);
    if (pending.length) {
      throw new Error(`The database schema is behind this build (${pending.length} pending: ${pending.join(', ')}). Run \`npm run db:migrate\`.`);
    }
    this.logger.log(`Connected to PostgreSQL in ${Date.now() - started}ms`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createPool(config.database) },
    { provide: DATABASE, inject: [PG_POOL], useFactory: createDatabase },
    DatabaseLifecycle,
    SequencesService,
  ],
  exports: [DATABASE, PG_POOL, SequencesService],
})
export class DatabaseModule {}
