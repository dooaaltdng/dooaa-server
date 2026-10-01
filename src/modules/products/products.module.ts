import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CategoriesService } from '../categories/categories.service';
import { Category, CategorySchema } from '../categories/category.schema';
import { WishlistItem, WishlistItemSchema } from '../wishlist/wishlist.schema';
import { ReviewsModule } from '../reviews/reviews.module';
import { AdminListingsController } from './admin-listings.controller';
import { CatalogController } from './catalog.controller';
import { ProductsService } from './products.service';
import { Product, ProductSchema } from './schemas/product.schema';
import { SellerProductsController } from './seller-products.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Category.name, schema: CategorySchema },
      { name: WishlistItem.name, schema: WishlistItemSchema },
    ]),
    ReviewsModule,
  ],
  controllers: [CatalogController, SellerProductsController, AdminListingsController],
  providers: [ProductsService, CategoriesService],
  exports: [ProductsService, CategoriesService, MongooseModule],
})
export class ProductsModule implements OnModuleInit {
  constructor(private readonly categories: CategoriesService) {}

  /** The taxonomy is reference data the storefront cannot work without. */
  async onModuleInit(): Promise<void> {
    await this.categories.ensureDefaults();
  }
}
