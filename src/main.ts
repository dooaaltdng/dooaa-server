import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { API_PREFIX, configureApp } from './bootstrap';
import { loadEnvFiles } from './config/env-files';

async function bootstrap() {
  // Configuration is read when the app module initialises, so the env file only has to be loaded first.
  loadEnvFiles();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  const config = configureApp(app);

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('DOOAA.NG API')
        .setDescription(
          'Marketplace API for the DOOAA client and admin console. Every response is `{ ok: true, data }` or `{ ok: false, error, code }`. ' +
            'Realtime events are on the Socket.IO namespace `/realtime`.',
        )
        .setVersion('1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'user')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'staff')
        .build(),
    );
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/json' });
  }

  await app.listen(config.port, '0.0.0.0');
  app.get(Logger).log(`DOOAA API listening on :${config.port}/${API_PREFIX} (${config.env})`);
}

void bootstrap();