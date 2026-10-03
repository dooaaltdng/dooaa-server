import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser, RequireVerifiedEmail, SellerOnly } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { PageQueryDto } from '../../common/util/pagination';
import { WalletService } from '../wallet/wallet.service';
import { DeliverOrderDto, OrdersQueryDto, ReasonDto, ShipOrderDto } from './dto/orders.dto';
import { OrdersService } from './orders.service';

class RecentQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) limit?: number;
}

class WithdrawDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter an amount.' }) @Min(1, { message: 'Enter an amount.' }) amount: number;
  @IsString() @MinLength(1, { message: 'Enter your password.' }) @MaxLength(128) password: string;
  /** Defaults to the primary payout account. */
  @IsOptional() @IsMongoId() accountId?: string;
  @IsOptional() @IsIn(['bank', 'paypal']) destination?: 'bank' | 'paypal';
}

@ApiTags('Seller · Orders')
@ApiBearerAuth('user')
@SellerOnly()
@Controller('seller')
export class SellerOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
  ) {}

  /** The dashboard tiles: revenue, orders, active products and pending orders, with weekly change. */
  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.orders.sellerSummary(user);
  }

  /** The Escrow Payments tiles: held, released and refunded across every sale. */
  @Get('escrow/summary')
  escrowSummary(@CurrentUser() user: AuthUser) {
    return this.orders.sellerEscrowSummary(user);
  }

  @Get('orders')
  list(@CurrentUser() user: AuthUser, @Query() query: OrdersQueryDto) {
    return this.orders.sellerList(user, query);
  }

  @Get('orders/recent')
  recent(@CurrentUser() user: AuthUser, @Query() query: RecentQueryDto) {
    return this.orders.sellerRecent(user, query.limit ?? 6);
  }

  @Get('orders/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.sellerGet(user, id);
  }

  @HttpCode(200)
  @Post('orders/:id/confirm')
  confirm(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.confirm(user, id);
  }

  /** "Marked as Shipped": the carrier and tracking number. */
  @HttpCode(200)
  @Post('orders/:id/ship')
  ship(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ShipOrderDto) {
    return this.orders.ship(user, id, body);
  }

  /** A meetup handover or courier proof of delivery: starts the buyer's inspection period. */
  @HttpCode(200)
  @Post('orders/:id/deliver')
  deliver(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: DeliverOrderDto) {
    return this.orders.deliver(user, id, body);
  }

  @HttpCode(200)
  @Post('orders/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: ReasonDto) {
    return this.orders.cancelBySeller(user, id, body.reason);
  }

  /** Earnings & Payouts: balances, released earnings and payout history. */
  @Get('earnings')
  earnings(@CurrentUser() user: AuthUser, @Query() query: PageQueryDto) {
    return this.wallet.summary(user.id, query.page, query.limit);
  }

  @Get('payouts')
  payouts(@CurrentUser() user: AuthUser, @Query() query: PageQueryDto) {
    return this.wallet.payoutPage(user.id, query.page, query.limit);
  }

  /** The Withdraw dialog: amount and password; the provider transfers to the seller's bank. */
  @RequireVerifiedEmail()
  @AuthThrottle()
  @Post('payouts')
  withdraw(@CurrentUser() user: AuthUser, @Body() body: WithdrawDto) {
    return this.wallet.requestPayout(user, body);
  }
}
