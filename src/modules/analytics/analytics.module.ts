import { Module } from '@nestjs/common';
import { AdminDashboardController, AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { GeoService } from './geo.service';

@Module({
  controllers: [AnalyticsController, AdminDashboardController],
  providers: [AnalyticsService, GeoService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
