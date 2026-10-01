import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { StaffAuthController } from './staff-auth.controller';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [UsersModule],
  controllers: [StaffAuthController, StaffController],
  providers: [StaffService],
  exports: [StaffService],
})
export class StaffModule {}
