import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { CACHE_STORE } from '../../src/cache/cache.store';
import { DATABASE, type Database } from '../../src/database/database';
import { MailService } from '../../src/modules/mail/mail.service';
import { MAIL_TRANSPORT } from '../../src/modules/mail/mail.transport';
import { STORAGE_DRIVER } from '../../src/modules/media/storage/storage.driver';
import { SmsService } from '../../src/modules/sms/sms.service';
import { TEMPLATE_DATABASE } from '../setup/database';
import { FAKE_BACHS_SECRET_KEY, FAKE_BACHS_WEBHOOK_SECRET, FakeBachs } from './fake-bachs';
import { MailOutbox } from './mail-outbox';
import { MemoryCacheStore } from './memory-cache.store';
import { MemoryStorage } from './memory-storage';

export type TestApp = {
  app: NestExpressApplication;
  server: ReturnType<INestApplication['getHttpServer']>;
  /** Everything the app emailed. */
  mail: MailOutbox;
  sms: SmsService;
  /** The Drizzle client on this app's own database. */
  db: Database;
  /** The fake Bachs the app's payment provider talks to. */
  bachs: FakeBachs;
  /** The app's own base URL on the loopback address (WebSocket tests dial it). */
  url: string;
  get<T>(token: unknown): T;
  close(): Promise<void>;
};

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.PG_TEST_ADMIN_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Boots the real AppModule against a private copy of the migrated template
 * database. Redis, Cloudinary and SMTP are swapped for in-memory doubles;
 * Bachs is a fake HTTP server the real provider calls. `env` overrides are
 * applied only while the app reads its configuration.
 */
export async function createTestApp(options: { env?: Record<string, string>; /** Kept for callers; every test app listens now. */ listen?: boolean } = {}): Promise<TestApp> {
  const database = `t_${process.env.JEST_WORKER_ID ?? '0'}_${randomBytes(4).toString('hex')}`;
  await admin((client) => client.query(`create database ${database} template ${TEMPLATE_DATABASE}`));
  const databaseUrl = new URL(process.env.PG_TEST_ADMIN_URL!);
  databaseUrl.pathname = `/${database}`;

  const bachs = new FakeBachs();
  const bachsUrl = await bachs.start();

  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl.toString(),
    DATABASE_POOL_MAX: '5',
    BACHS_SECRET_KEY: FAKE_BACHS_SECRET_KEY,
    BACHS_WEBHOOK_SECRET: FAKE_BACHS_WEBHOOK_SECRET,
    BACHS_BASE_URL: bachsUrl,
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  const mail = new MailOutbox();
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CACHE_STORE)
      .useValue(new MemoryCacheStore())
      .overrideProvider(STORAGE_DRIVER)
      .useValue(new MemoryStorage())
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(mail)
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    configureApp(app);
    // Always listen on the loopback address itself. Left to supertest, each
    // request would bind a wildcard ephemeral port and dial 127.0.0.1 on it —
    // and on macOS that port number can already belong to another process's
    // loopback socket, which then answers instead of this app.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    bachs.webhookUrl = `${url}/api/v1/payments/webhooks/bachs`;
    mail.attach(app.get(MailService));
    return {
      app,
      server: app.getHttpServer(),
      mail,
      sms: app.get(SmsService),
      db: app.get<Database>(DATABASE),
      bachs,
      url,
      get: <T>(token: unknown) => app.get(token as never) as T,
      close: async () => {
        await bachs.idle();
        await app.close();
        await bachs.stop();
        await admin((client) => client.query(`drop database if exists ${database} with (force)`)).catch(() => undefined);
      },
    };
  } catch (error) {
    await bachs.stop();
    throw error;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
