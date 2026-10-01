import { NestExpressApplication } from '@nestjs/platform-express';
import { Reflector } from '@nestjs/core';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { join } from 'node:path';
import { AllExceptionsFilter } from './common/api/all-exceptions.filter';
import { EnvelopeInterceptor } from './common/api/envelope.interceptor';
import { createValidationPipe } from './common/api/validation';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { RealtimeIoAdapter } from './modules/realtime/realtime.adapter';

export const API_PREFIX = 'api/v1';

/**
 * Everything an app instance needs beyond its modules. Shared by main.ts and
 * the e2e harness so tests exercise exactly what production runs.
 */
export function configureApp(app: NestExpressApplication): AppConfig {
  const config = app.get<AppConfig>(APP_CONFIG);

  app.set('trust proxy', 1);
  app.setGlobalPrefix(API_PREFIX);
  app.use(
    helmet({
      // Media and the sandbox checkout are loaded cross-origin by the two apps.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Visitor-Id'],
    maxAge: 600,
  });
  app.useWebSocketAdapter(new RealtimeIoAdapter(app, config));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new EnvelopeInterceptor(app.get(Reflector)));

  if (config.storage.driver === 'local') {
    app.useStaticAssets(join(process.cwd(), config.storage.localDir, 'public'), {
      prefix: '/uploads/',
      maxAge: '7d',
      immutable: true,
      index: false,
    });
  }
  app.enableShutdownHooks();
  return config;
}
