import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { AdminVerificationController, VerificationController } from './verification.controller';
import { Verification, VerificationSchema } from './verification.schema';
import { VerificationService } from './verification.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Verification.name, schema: VerificationSchema }]), UsersModule, ProductsModule],
  controllers: [VerificationController, AdminVerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
