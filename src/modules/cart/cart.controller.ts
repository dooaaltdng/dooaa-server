import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentUser } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { CartService } from './cart.service';
import { AddCartItemDto, CouponDto, DeliveryInfoDto, MergeCartDto, SetQuantityDto } from './dto/cart.dto';

@ApiTags('Cart')
@ApiBearerAuth('user')
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  view(@CurrentUser() user: AuthUser) {
    return this.cart.view(user);
  }

  @Post('items')
  add(@CurrentUser() user: AuthUser, @Body() body: AddCartItemDto) {
    return this.cart.add(user, body.productId, body.quantity ?? 1);
  }

  @Patch('items/:productId')
  setQuantity(@CurrentUser() user: AuthUser, @Param('productId', ObjectIdPipe) productId: string, @Body() body: SetQuantityDto) {
    return this.cart.setQuantity(user, productId, body.quantity);
  }

  @Delete('items/:productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId', ObjectIdPipe) productId: string) {
    return this.cart.remove(user, productId);
  }

  @Delete()
  clear(@CurrentUser() user: AuthUser) {
    return this.cart.clear(user);
  }

  @Post('coupon')
  applyCoupon(@CurrentUser() user: AuthUser, @Body() body: CouponDto) {
    return this.cart.applyCoupon(user, body.code);
  }

  @Delete('coupon')
  removeCoupon(@CurrentUser() user: AuthUser) {
    return this.cart.removeCoupon(user);
  }

  @Put('delivery')
  setDelivery(@CurrentUser() user: AuthUser, @Body() body: DeliveryInfoDto) {
    return this.cart.setDelivery(user, body);
  }

  @Post('merge')
  merge(@CurrentUser() user: AuthUser, @Body() body: MergeCartDto) {
    return this.cart.merge(user, body.items);
  }
}
