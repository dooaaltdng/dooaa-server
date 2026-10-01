import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentUser, SellerOnly } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { CreateProductDto, SellerProductStatusDto, SellerProductsQueryDto, UpdateProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';

/** The seller's Products tab, product page and the Add New Product wizard. */
@ApiTags('Seller · Products')
@ApiBearerAuth('user')
@SellerOnly()
@Controller('seller/products')
export class SellerProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: SellerProductsQueryDto) {
    return this.products.sellerList(user, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateProductDto) {
    return this.products.create(user, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.products.sellerGet(user, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: UpdateProductDto) {
    return this.products.update(user, id, body);
  }

  @Patch(':id/status')
  status(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: SellerProductStatusDto) {
    return this.products.setSellerStatus(user, id, body.status);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.products.remove(user, id);
  }
}
