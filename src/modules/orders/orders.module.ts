import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CartModule } from '../cart/cart.module';
import { Offer, OfferSchema } from '../conversations/schemas/offer.schema';
import { CouponsModule } from '../coupons/coupons.module';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminEscrowController } from './admin-escrow.controller';
import { CheckoutService } from './checkout.service';
import { EscrowAdminService } from './escrow-admin.service';
import { CheckoutController, OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './schemas/order.schema';
import { SellerOrdersController } from './seller-orders.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Offer.name, schema: OfferSchema },
    ]),
    UsersModule,
    ProductsModule,
    CartModule,
    CouponsModule,
    WalletModule,
  ],
  controllers: [CheckoutController, OrdersController, SellerOrdersController, AdminEscrowController],
  providers: [OrdersService, CheckoutService, EscrowAdminService],
  exports: [OrdersService, CheckoutService, MongooseModule],
})
export class OrdersModule {}
