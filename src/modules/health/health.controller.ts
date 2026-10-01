import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Connection } from 'mongoose';
import { Public } from '../../common/auth/decorators';

const startedAt = Date.now();

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Public()
  @Get()
  async health() {
    let db: 'up' | 'down' = 'down';
    try {
      const result = await this.connection.db?.admin().ping();
      db = result?.ok ? 'up' : 'down';
    } catch {
      db = 'down';
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }
}
