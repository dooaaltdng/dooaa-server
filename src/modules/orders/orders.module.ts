import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CouponsModule } from '../coupons/coupons.module';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminEscrowController } from './admin-escrow.controller';
import { CheckoutService } from './checkout.service';
import { EscrowAdminService } from './escrow-admin.service';
import { CheckoutController, OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SellerOrdersController } from './seller-orders.controller';

@Module({
  imports: [UsersModule, ProductsModule, CartModule, CouponsModule, WalletModule],
  controllers: [CheckoutController, OrdersController, SellerOrdersController, AdminEscrowController],
  providers: [OrdersService, CheckoutService, EscrowAdminService],
  exports: [OrdersService, CheckoutService],
})
export class OrdersModule {}
