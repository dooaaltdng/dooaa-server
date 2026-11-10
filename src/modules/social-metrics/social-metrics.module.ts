import { Module } from '@nestjs/common';
import { SocialMetricsController } from './social-metrics.controller';
import { SocialMetricsService } from './social-metrics.service';

@Module({
  controllers: [SocialMetricsController],
  providers: [SocialMetricsService],
})
export class SocialMetricsModule {}
