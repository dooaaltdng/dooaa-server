import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AllowRestricted, CurrentUser } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { CartService } from '../cart/cart.service';
import { ConversationsService } from '../conversations/conversations.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { WishlistService } from '../wishlist/wishlist.service';

/** The buyer dashboard's tiles and the header badges, in one call. */
@ApiTags('Account')
@ApiBearerAuth('user')
@Controller('me')
export class AccountController {
  constructor(
    private readonly orders: OrdersService,
    private readonly conversations: ConversationsService,
    private readonly wishlist: WishlistService,
    private readonly notifications: NotificationsService,
    private readonly cart: CartService,
  ) {}

  @AllowRestricted()
  @Get('summary')
  async summary(@CurrentUser() user: AuthUser) {
    const [orders, unread, wishlist, notifications, cart] = await Promise.all([
      this.orders.countForBuyer(user.id),
      this.conversations.unreadCount(user.id),
      this.wishlist.count(user.id),
      this.notifications.unreadCount({ id: user.id, type: 'user' }),
      this.cart.view(user),
    ]);
    return { orders, messages: unread.threads, unreadMessages: unread.messages, wishlist, notifications, cart: cart.count };
  }
}
