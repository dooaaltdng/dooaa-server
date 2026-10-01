import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Staff, StaffSchema } from '../staff/schemas/staff.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AuthGuard } from './auth.guard';
import { PrincipalService } from './principal.service';
import { Session, SessionSchema } from './schemas/session.schema';
import { TokenService } from './token.service';

/**
 * Token issuing/verification and the global guard. Global so every feature
 * module and the WebSocket gateway can authenticate without import chains.
 */
@Global()
@Module({
  imports: [
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: User.name, schema: UserSchema },
      { name: Staff.name, schema: StaffSchema },
    ]),
  ],
  providers: [TokenService, PrincipalService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [TokenService, PrincipalService, MongooseModule],
})
export class AuthCoreModule {}
