import { Global, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection, MongooseModule } from '@nestjs/mongoose';
import { Counter, CounterSchema } from './counter.schema';
import { CountersService } from './counters.service';
import { Connection } from 'mongoose';

/**
 * Waits for every collection's indexes before the app starts serving. On a
 * fresh database the text index (catalog search) and unique indexes
 * (emails, references) would otherwise be built in the background while the
 * first requests arrive.
 */
@Injectable()
export class IndexBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('Database');

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap(): Promise<void> {
    const models = Object.values(this.connection.models);
    const started = Date.now();
    await Promise.all(models.map((model) => model.init()));
    this.logger.log(`Indexes ready for ${models.length} collections in ${Date.now() - started}ms`);
  }
}

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Counter.name, schema: CounterSchema }])],
  providers: [IndexBootstrap, CountersService],
  exports: [CountersService],
})
export class DatabaseModule {}
