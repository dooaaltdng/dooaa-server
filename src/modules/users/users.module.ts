import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { PasswordService } from './password.service';
import { UsersService } from './users.service';

/** Account storage and the signed-in user's own settings. The `User` model is registered globally by AuthCoreModule. */
@Module({
  controllers: [MeController],
  providers: [UsersService, PasswordService, MeService],
  exports: [UsersService, PasswordService],
})
export class UsersModule {}
