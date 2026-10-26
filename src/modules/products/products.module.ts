import { Module, OnModuleInit } from '@nestjs/common';
import { CategoriesService } from '../categories/categories.service';
import { ReviewsModule } from '../reviews/reviews.module';
import { UsersModule } from '../users/users.module';
import { AdminListingsController } from './admin-listings.controller';
import { CatalogController } from './catalog.controller';
import { ProductsService } from './products.service';
import { SellerProductsController } from './seller-products.controller';

@Module({
  imports: [UsersModule, ReviewsModule],
  controllers: [CatalogController, SellerProductsController, AdminListingsController],
  providers: [ProductsService, CategoriesService],
  exports: [ProductsService, CategoriesService],
})
export class ProductsModule implements OnModuleInit {
  constructor(private readonly categories: CategoriesService) {}

  /** The taxonomy is reference data the storefront cannot work without. */
  async onModuleInit(): Promise<void> {
    await this.categories.ensureDefaults();
  }
}
