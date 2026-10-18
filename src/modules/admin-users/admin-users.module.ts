import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [UsersModule, ProductsModule, OrdersModule, VerificationModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminUsersModule {}
