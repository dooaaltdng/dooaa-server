import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentStaff, CurrentUser, Public, RequirePermissions, SellerOnly, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { PageQueryDto } from '../../common/util/pagination';
import { Trim } from '../../common/util/transforms';
import { ReviewsService } from './reviews.service';

class AspectsDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) communication?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) valueForMoney?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) itemAsDescribed?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) shippingSpeed?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) professionalism?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) responsiveness?: number;
}

class CreateReviewDto {
  @Type(() => Number) @IsInt({ message: 'Choose a rating.' }) @Min(1, { message: 'Choose a rating.' }) @Max(5) rating: number;
  @IsOptional() @ValidateNested() @Type(() => AspectsDto) aspects?: AspectsDto;
  @IsOptional() @Trim() @IsString() @MaxLength(2000) body?: string;
}

class ReplyDto {
  @Trim() @IsString() @MinLength(2, { message: 'Write a reply.' }) @MaxLength(1000) body: string;
}

class HideDto {
  @IsBoolean() hidden: boolean;
}

@ApiTags('Reviews')
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** "Write a review" / the feedback dialog after a completed order. */
  @Post('orders/:id/review')
  create(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: CreateReviewDto) {
    return this.reviews.create(user, id, body);
  }

  @Public()
  @Get('products/:id/reviews')
  product(@Param('id', ObjectIdPipe) id: string, @Query() query: PageQueryDto) {
    return this.reviews.forProduct(id, query.page, query.limit);
  }

  @Public()
  @Get('sellers/:id/reviews')
  async seller(@Param('id', ObjectIdPipe) id: string, @Query() query: PageQueryDto) {
    return { summary: await this.reviews.summary(id), reviews: await this.reviews.forSeller(id, query.page, query.limit) };
  }
}

@ApiTags('Seller · Ratings')
@SellerOnly()
@Controller('seller/reviews')
export class SellerReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Reviews & Ratings: the summary cards and the list. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() query: PageQueryDto) {
    return { summary: await this.reviews.summary(user.id), reviews: await this.reviews.forSeller(user.id, query.page, query.limit) };
  }

  @Post(':id/reply')
  reply(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: ReplyDto) {
    return this.reviews.reply(user, id, body.body);
  }
}

@ApiTags('Admin · Reviews')
@StaffOnly()
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @RequirePermissions('listings.moderate')
  @Patch(':id')
  hide(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: HideDto) {
    return this.reviews.setHidden(staff, id, body.hidden);
  }
}
