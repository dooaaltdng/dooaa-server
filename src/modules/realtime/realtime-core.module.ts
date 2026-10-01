import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';

/** The push side of realtime, available everywhere without importing the gateway. */
@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeCoreModule {}
