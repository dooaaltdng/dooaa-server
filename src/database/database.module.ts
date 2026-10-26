import { Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DATABASE, Database, InjectDb, MONGO_CLIENT } from './database';
import * as schema from './schema';
import { counters, type Table } from './schema';

export function createClient(config: AppConfig['database']): MongoClient {
  return new MongoClient(config.url, {
    maxPoolSize: config.poolMax,
    serverSelectionTimeoutMS: 10_000,
    appName: 'dooaa-server',
  });
}

export function createDatabase(client: MongoClient, config: AppConfig['database']): Database {
  return new Database(client, client.db(config.name));
}

/** Every collection the schema declares. */
export const TABLES: Table[] = (Object.values(schema) as unknown[]).filter(
  (value): value is Table => !!value && typeof value === 'object' && Array.isArray((value as Table).indexes) && typeof (value as Table).key === 'string',
);

/** Creates every declared index. Idempotent; MongoDB skips indexes that already exist. */
export async function ensureIndexes(db: Database): Promise<void> {
  for (const table of TABLES) {
    if (table.indexes.length) await db.collection(table).createIndexes(table.indexes);
  }
}

/** Next value of a named sequence (dispute and support ticket numbers). */
@Injectable()
export class SequencesService {
  constructor(@InjectDb() private readonly db: Database) {}

  async next(sequence: { name: string; startWith: number }): Promise<number> {
    // The counter counts calls; the first one returns `startWith`.
    const row = await this.db.upsert(counters, { id: sequence.name }, { $inc: { value: 1 } });
    return sequence.startWith - 1 + row.value;
  }
}

/**
 * Connects before the app serves anything, makes sure the indexes exist and
 * closes the client on shutdown.
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Database');

  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @InjectDb() private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const started = Date.now();
    await this.client.connect();
    await this.db.db.command({ ping: 1 });
    await ensureIndexes(this.db);
    this.logger.log(`Connected to MongoDB (${this.db.db.databaseName}) in ${Date.now() - started}ms`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}

@Global()
@Module({
  providers: [
    { provide: MONGO_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createClient(config.database) },
    {
      provide: DATABASE,
      inject: [MONGO_CLIENT, APP_CONFIG],
      useFactory: (client: MongoClient, config: AppConfig) => createDatabase(client, config.database),
    },
    DatabaseLifecycle,
    SequencesService,
  ],
  exports: [DATABASE, MONGO_CLIENT, SequencesService],
})
export class DatabaseModule {}
