import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { UuidPipe } from '../../common/api/uuid.pipe';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { CONDITIONS, LISTING_STATUSES, type Condition, type ListingStatus } from '../../common/domain';
import { PageQueryDto } from '../../common/util/pagination';
import { ToArray, Trim } from '../../common/util/transforms';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { CreateProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';

class AdminListingsQueryDto extends PageQueryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @ToArray() @IsArray() @IsIn(LISTING_STATUSES, { each: true }) statuses?: ListingStatus[];
  @IsOptional() @ToArray() @IsArray() @IsString({ each: true }) categories?: string[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxPrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minStock?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxStock?: number;
  @IsOptional() @IsString() sellerId?: string;
}

class ModerateListingDto {
  @IsIn(['active', 'pending', 'suspicious', 'inactive', 'rejected']) status: ListingStatus;
  @IsOptional() @Trim() @IsString() @MaxLength(500) note?: string;
}

class FeatureListingDto {
  @IsBoolean() featured: boolean;
}

class AdminCreateListingDto extends CreateProductDto {
  /** "pending" sends the listing through the same review queue as a seller's. */
  @IsOptional() @IsIn(['active', 'pending', 'inactive', 'draft']) status?: 'active' | 'pending' | 'inactive' | 'draft';
  @IsOptional() @IsIn(['official', 'admin']) listedAs?: 'official' | 'admin';
  /** The console's form has no condition field; the official store sells new stock. */
  @IsOptional() @IsIn(CONDITIONS) declare condition: Condition;
}

class UpdateCategoryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(500) image?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() order?: number;
}

class CreateCategoryDto {
  @Trim() @IsString() @MinLength(2, { message: 'Give the category a name.' }) @MaxLength(60) name: string;
  @IsOptional() @Trim() @IsString() @MaxLength(200) description?: string;
  @IsOptional() @IsString() @MaxLength(500) image?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Items & Listing Management. */
@ApiTags('Admin · Listings')
@StaffOnly()
@Controller('admin')
export class AdminListingsController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly audit: AuditService,
  ) {}

  @Get('listings')
  list(@Query() query: AdminListingsQueryDto) {
    return this.products.adminList(query);
  }

  @Get('listings/:id')
  get(@Param('id', UuidPipe) id: string) {
    return this.products.adminGet(id);
  }

  @RequirePermissions('listings.moderate')
  @Post('listings')
  create(@CurrentStaff() staff: AuthStaff, @Body() body: AdminCreateListingDto) {
    return this.products.adminCreate(staff, body);
  }

  @RequirePermissions('listings.moderate')
  @Patch('listings/:id/status')
  moderate(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string, @Body() body: ModerateListingDto) {
    return this.products.moderate(staff, id, body.status, body.note);
  }

  @RequirePermissions('listings.moderate')
  @Patch('listings/:id/featured')
  feature(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string, @Body() body: FeatureListingDto) {
    return this.products.setFeatured(staff, id, body.featured);
  }

  @RequirePermissions('listings.delete')
  @Delete('listings/:id')
  remove(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string) {
    return this.products.adminRemove(staff, id);
  }

  @Get('categories')
  allCategories() {
    return this.categories.adminList();
  }

  @RequirePermissions('settings.manage')
  @Post('categories')
  async createCategory(@CurrentStaff() staff: AuthStaff, @Body() body: CreateCategoryDto) {
    const created = await this.categories.create(body);
    await this.audit.record(staff, { action: 'Created a category', target: created.name, targetType: 'category', targetId: created.slug });
    return created;
  }

  @RequirePermissions('settings.manage')
  @Patch('categories/:slug')
  async updateCategory(@CurrentStaff() staff: AuthStaff, @Param('slug') slug: string, @Body() body: UpdateCategoryDto) {
    const updated = await this.categories.update(slug, body);
    const what = body.active === false ? 'Hid a category' : body.active === true && Object.keys(body).length === 1 ? 'Showed a category' : 'Edited a category';
    await this.audit.record(staff, { action: what, target: updated.name, targetType: 'category', targetId: slug });
    return updated;
  }

  @RequirePermissions('settings.manage')
  @Delete('categories/:slug')
  async deleteCategory(@CurrentStaff() staff: AuthStaff, @Param('slug') slug: string) {
    const removed = await this.categories.remove(slug);
    await this.audit.record(staff, { action: 'Deleted a category', target: removed.name, targetType: 'category', targetId: slug });
    return { deleted: true, slug };
  }
}
