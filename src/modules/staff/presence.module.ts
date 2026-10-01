import { Global, Module } from '@nestjs/common';
import { PRESENCE, PresenceRegistry } from './presence';

@Global()
@Module({
  providers: [{ provide: PRESENCE, useValue: new PresenceRegistry() }],
  exports: [PRESENCE],
})
export class PresenceModule {}
