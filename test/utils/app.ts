import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import type { Connection } from 'mongoose';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { MailService } from '../../src/modules/mail/mail.service';
import { SmsService } from '../../src/modules/sms/sms.service';

export type TestApp = {
  app: NestExpressApplication;
  server: ReturnType<INestApplication['getHttpServer']>;
  mail: MailService;
  sms: SmsService;
  connection: Connection;
  /** The app's own base URL on the loopback address (WebSocket tests dial it). */
  url: string;
  get<T>(token: unknown): T;
  close(): Promise<void>;
};

/**
 * Boots the real AppModule against a private database on the shared
 * in-memory MongoDB. `env` overrides are applied only while the app reads
 * its configuration.
 */
export async function createTestApp(options: { env?: Record<string, string>; /** Kept for callers; every test app listens now. */ listen?: boolean } = {}): Promise<TestApp> {
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    MONGODB_URI: process.env.MONGO_TEST_URI!,
    MONGODB_DB: `t_${process.env.JEST_WORKER_ID ?? '0'}_${randomBytes(4).toString('hex')}`,
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    configureApp(app);
    // Always listen on the loopback address itself. Left to supertest, each
    // request would bind a wildcard ephemeral port and dial 127.0.0.1 on it —
    // and on macOS that port number can already belong to another process's
    // loopback socket, which then answers instead of this app.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const connection = app.get<Connection>(getConnectionToken());
    return {
      app,
      server: app.getHttpServer(),
      mail: app.get(MailService),
      sms: app.get(SmsService),
      connection,
      url,
      get: <T>(token: unknown) => app.get(token as never) as T,
      close: async () => {
        await connection.dropDatabase().catch(() => undefined);
        await app.close();
      },
    };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
