import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentUser } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { WishlistService } from './wishlist.service';

class RestockAlertDto {
  @IsBoolean() on: boolean;
}

@ApiTags('Wishlist')
@ApiBearerAuth('user')
@Controller()
export class WishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get('wishlist')
  list(@CurrentUser() user: AuthUser) {
    return this.wishlist.list(user);
  }

  /** Just the ids, for the hearts on product cards. */
  @Get('wishlist/ids')
  ids(@CurrentUser() user: AuthUser) {
    return this.wishlist.ids(user);
  }

  @Put('wishlist/:productId')
  add(@CurrentUser() user: AuthUser, @Param('productId', ObjectIdPipe) productId: string) {
    return this.wishlist.add(user, productId);
  }

  @Delete('wishlist/:productId')
  remove(@CurrentUser() user: AuthUser, @Param('productId', ObjectIdPipe) productId: string) {
    return this.wishlist.remove(user, productId);
  }

  @Delete('wishlist')
  clear(@CurrentUser() user: AuthUser) {
    return this.wishlist.clear(user);
  }

  @Put('products/:productId/restock-alert')
  restockAlert(@CurrentUser() user: AuthUser, @Param('productId', ObjectIdPipe) productId: string, @Body() body: RestockAlertDto) {
    return this.wishlist.setRestockAlert(user, productId, body.on);
  }
}
