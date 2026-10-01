import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser, RequireVerifiedEmail } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { CartService } from '../cart/cart.service';
import { CheckoutService } from './checkout.service';
import { CheckoutDto, EscrowCheckoutDto, EscrowQuoteQueryDto, OrdersQueryDto, ReasonDto, ReleaseCodeDto, ReleaseDto } from './dto/orders.dto';
import { OrdersService } from './orders.service';

class RecentQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}

@ApiTags('Checkout')
@ApiBearerAuth('user')
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /** Pays for the cart. Returns the orders and where to send the buyer to pay. */
  @RequireVerifiedEmail()
  @AuthThrottle()
  @Post()
  cart(@CurrentUser() user: AuthUser, @Body() body: CheckoutDto) {
    return this.checkout.checkoutCart(user, {
      method: body.method,
      savedCardId: body.savedCardId,
      delivery: body.delivery ? { ...body.delivery, state: body.delivery.state ?? '', zip: body.delivery.zip ?? '' } : undefined,
    });
  }

  @Get('escrow/:productId/quote')
  quote(@CurrentUser() user: AuthUser, @Param('productId') productId: string, @Query() query: EscrowQuoteQueryDto) {
    return this.checkout.quoteEscrow(user, productId, query.quantity ?? 1, query.offerId);
  }

  /** "Buy Now via Escrow". */
  @RequireVerifiedEmail()
  @AuthThrottle()
  @Post('escrow')
  escrow(@CurrentUser() user: AuthUser, @Body() body: EscrowCheckoutDto) {
    return this.checkout.checkoutEscrow(user, {
      productId: body.productId,
      quantity: body.quantity,
      method: body.method,
      savedCardId: body.savedCardId,
      offerId: body.offerId,
      delivery: { ...body.delivery, state: body.delivery.state ?? '', zip: body.delivery.zip ?? '' },
    });
  }
}

@ApiTags('Orders')
@ApiBearerAuth('user')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly cart: CartService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: OrdersQueryDto) {
    return this.orders.list(user, query);
  }

  /** The dashboard's most recent orders. */
  @Get('recent')
  recent(@CurrentUser() user: AuthUser, @Query() query: RecentQueryDto) {
    return this.orders.recent(user, query.limit ?? 4);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.get(user, id);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ReasonDto) {
    return this.orders.cancelByBuyer(user, id, body.reason);
  }

  @HttpCode(200)
  @Post(':id/request-cancellation')
  requestCancellation(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ReasonDto) {
    return this.orders.requestCancellation(user, id, body.reason);
  }

  /** "Item marked as received" — starts the inspection period. */
  @HttpCode(200)
  @Post(':id/received')
  received(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.markReceived(user, id);
  }

  @AuthThrottle()
  @HttpCode(200)
  @Post(':id/release/code')
  releaseCode(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ReleaseCodeDto) {
    return this.orders.sendReleaseCode(user, id, body.channel);
  }

  /** Confirms the purchase with the code and releases payment to the seller. */
  @AuthThrottle()
  @HttpCode(200)
  @Post(':id/release')
  release(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ReleaseDto) {
    return this.orders.release(user, id, body.code);
  }

  /** "Buy again": puts the order's items back in the cart where they can still be bought. */
  @HttpCode(200)
  @Post(':id/reorder')
  async reorder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const order = await this.orders.get(user, id);
    const added: string[] = [];
    const skipped: { productId: string; name: string; reason: string }[] = [];
    for (const item of order.items) {
      try {
        await this.cart.add(user, item.productId, item.quantity);
        added.push(item.productId);
      } catch (error) {
        skipped.push({ productId: item.productId, name: item.name, reason: (error as Error).message });
      }
    }
    return { added: added.length, skipped, cart: await this.cart.view(user) };
  }
}
