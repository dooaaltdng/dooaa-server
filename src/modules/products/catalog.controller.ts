import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentUser, Public } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { PageQueryDto } from '../../common/util/pagination';
import { CategoriesService } from '../categories/categories.service';
import { ReviewsService } from '../reviews/reviews.service';
import { CatalogQueryDto, SuggestQueryDto } from './dto/product.dto';
import { ProductsService } from './products.service';

/** Everything a visitor can browse without signing in. A signed-in viewer also gets their wishlist hearts. */
@ApiTags('Catalog')
@Public()
@Controller()
export class CatalogController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('categories')
  listCategories() {
    return this.categories.list();
  }

  @Get('categories/:slug')
  category(@Param('slug') slug: string) {
    return this.categories.get(slug);
  }

  @Get('catalog/home')
  home(@CurrentUser() user?: AuthUser) {
    return this.products.homepage(user);
  }

  @Get('products')
  search(@Query() query: CatalogQueryDto, @CurrentUser() user?: AuthUser) {
    return this.products.search(query, user);
  }

  @Get('products/suggest')
  suggest(@Query() query: SuggestQueryDto) {
    return this.products.suggest(query.q);
  }

  /** The product page: gallery, specs, seller panel, rating, the latest reviews and related items. */
  @Get('products/:id')
  async detail(@Param('id', ObjectIdPipe) id: string, @CurrentUser() user?: AuthUser) {
    const [detail, reviews] = await Promise.all([this.products.detail(id, user), this.reviews.forProduct(id, 1, 3)]);
    return { ...detail, reviewCount: reviews.total, reviews: reviews.rows };
  }

  @Get('sellers/:id/products')
  sellerProducts(@Param('id', ObjectIdPipe) id: string, @Query() query: PageQueryDto, @CurrentUser() user?: AuthUser) {
    return this.products.bySeller(id, query.page, query.limit, user);
  }
}
