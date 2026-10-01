import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrdersModule } from '../orders/orders.module';
import { WishlistModule } from '../wishlist/wishlist.module';
import { AccountController } from './account.controller';

@Module({
  imports: [OrdersModule, ConversationsModule, WishlistModule, CartModule],
  controllers: [AccountController],
})
export class AccountModule {}
