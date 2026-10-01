import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { AdminDashboardController, AnalyticsController } from './analytics.controller';
import { DailyStat, DailyStatSchema, VisitorDay, VisitorDaySchema } from './analytics.schema';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DailyStat.name, schema: DailyStatSchema },
      { name: VisitorDay.name, schema: VisitorDaySchema },
      { name: Order.name, schema: OrderSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  controllers: [AnalyticsController, AdminDashboardController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
