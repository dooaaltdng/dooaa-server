import { Module } from '@nestjs/common';
import { AdminReviewsController, ReviewsController, SellerReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [ReviewsController, SellerReviewsController, AdminReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
