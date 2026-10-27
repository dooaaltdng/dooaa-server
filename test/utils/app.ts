import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { CACHE_STORE } from '../../src/cache/cache.store';
import { DATABASE, type Database } from '../../src/database/database';
import { settings as settingsTable } from '../../src/database/schema';
import { defaultSettings } from '../../src/modules/settings/settings.defaults';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { MailService } from '../../src/modules/mail/mail.service';
import { MAIL_TRANSPORT } from '../../src/modules/mail/mail.transport';
import { STORAGE_DRIVER } from '../../src/modules/media/storage/storage.driver';
import { SmsService } from '../../src/modules/sms/sms.service';
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
  /** The database handle on this app's own database. */
  db: Database;
  /** The fake Bachs the app's payment provider talks to. */
  bachs: FakeBachs;
  /** The app's own base URL on the loopback address (WebSocket tests dial it). */
  url: string;
  get<T>(token: unknown): T;
  close(): Promise<void>;
};

/**
 * Boots the real AppModule against its own database on the test MongoDB. Redis, Cloudinary and SMTP are swapped for in-memory doubles;
 * Bachs is a fake HTTP server the real provider calls. `env` overrides are
 * applied only while the app reads its configuration.
 */
export async function createTestApp(
  options: {
    env?: Record<string, string>;
    /** Kept for callers; every test app listens now. */
    listen?: boolean;
    /** Escrow ships switched off; most suites exercise it, so a test app starts with it on unless asked otherwise. */
    escrow?: boolean;
  } = {},
): Promise<TestApp> {
  const database = `t_${process.env.JEST_WORKER_ID ?? '0'}_${randomBytes(4).toString('hex')}`;

  const bachs = new FakeBachs();
  const bachsUrl = await bachs.start();

  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    MONGODB_URI: process.env.TEST_MONGODB_URI!,
    MONGODB_DB: database,
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
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CACHE_STORE)
      .useValue(new MemoryCacheStore())
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(mail);
    // Tests that exercise the Cloudinary driver ask for it (and mock its SDK); everyone else stores in memory.
    if (env.STORAGE_DRIVER !== 'cloudinary') builder = builder.overrideProvider(STORAGE_DRIVER).useValue(new MemoryStorage());
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: process.env.TEST_LOGS ? ['error'] : false });
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
    if (options.escrow !== false) {
      await app.get<Database>(DATABASE).upsert(settingsTable, { id: 'platform' }, { $set: { 'values.escrow': { ...defaultSettings().escrow, enabled: true } } });
      await app.get(SettingsService).invalidate();
    }
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
        const db = app.get<Database>(DATABASE);
        await db.db.dropDatabase().catch(() => undefined);
        await app.close();
        await bachs.stop();
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
