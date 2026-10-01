import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser, Public, SellerOnly, StaffOnly } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AnalyticsService, type TrendId } from './analytics.service';

class VisitDto {
  /** A random id the app keeps per browser (no personal data). */
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'Invalid visitor id.' }) visitorId: string;
}

class SellerRangeDto {
  @IsOptional() @IsIn(['7d', '30d', '12m']) range?: '7d' | '30d' | '12m';
}

class TrendRangeDto {
  @IsOptional() @IsIn(['7d', '30d', '90d']) range?: '7d' | '30d' | '90d';
}

class TrendParamDto {
  @IsIn(['transactions', 'activity']) id: TrendId;
}

@ApiTags('Analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** The storefront pings this once per page load; each visitor counts once a day. */
  @Public()
  @HttpCode(200)
  @Post('analytics/visit')
  visit(@Body() body: VisitDto) {
    return this.analytics.recordVisit(body.visitorId);
  }

  @SellerOnly()
  @Get('seller/analytics')
  seller(@CurrentUser() user: AuthUser, @Query() query: SellerRangeDto) {
    return this.analytics.sellerAnalytics(user.id, query.range ?? '12m');
  }
}

@ApiTags('Admin · Dashboard')
@StaffOnly()
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('metrics')
  metrics() {
    return this.analytics.dashboardMetrics();
  }

  @Get('trends/:id')
  trend(@Param() params: TrendParamDto, @Query() query: TrendRangeDto) {
    return this.analytics.trend(params.id, query.range ?? '30d');
  }
}
