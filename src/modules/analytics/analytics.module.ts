import { Module } from '@nestjs/common';
import { AdminDashboardController, AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController, AdminDashboardController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
