import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import type { AppConfig } from '../../config/configuration';

/** Socket.IO with the same CORS allow-list as the HTTP API. */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfig,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...(options ?? {}),
      cors: { origin: this.config.corsOrigins, credentials: true },
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxHttpBufferSize: 1e6,
    } as ServerOptions);
  }
}
