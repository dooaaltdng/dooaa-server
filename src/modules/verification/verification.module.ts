import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { AdminVerificationController, VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

@Module({
  imports: [UsersModule, ProductsModule],
  controllers: [VerificationController, AdminVerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
