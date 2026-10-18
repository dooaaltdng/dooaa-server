import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { PrincipalService } from './principal.service';
import { TokenService } from './token.service';

/**
 * Token issuing/verification and the global guard. Global so every feature
 * module and the WebSocket gateway can authenticate without import chains.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [TokenService, PrincipalService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenService, PrincipalService],
})
export class AuthCoreModule {}
