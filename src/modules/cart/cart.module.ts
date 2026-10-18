import { Module } from '@nestjs/common';
import { CouponsModule } from '../coupons/coupons.module';
import { ProductsModule } from '../products/products.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  imports: [ProductsModule, CouponsModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
