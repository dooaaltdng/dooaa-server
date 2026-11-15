import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Public, RequirePermissions, SellerOnly, StaffOnly } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AnalyticsService, type TrendId } from './analytics.service';
import { RequireFeature } from '../../common/auth/feature.guard';

class VisitDto {
  /** A random id the app keeps per browser (no personal data). */
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'Invalid visitor id.' }) visitorId: string;
  /** document.referrer of the page the visit landed on. */
  @IsOptional() @IsString() @MaxLength(2048) referrer?: string;
  /** utm_source (or ?ref=) from the landing URL. */
  @IsOptional() @IsString() @MaxLength(100) utmSource?: string;
  @IsOptional() @IsString() @MaxLength(100) utmMedium?: string;
}

class TrafficQueryDto {
  @IsOptional() @IsIn(['today', '7d', '30d', '90d']) range?: 'today' | '7d' | '30d' | '90d';
}

class RecentSignupsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

class SellerRangeDto {
  @IsOptional() @IsIn(['7d', '30d', '12m']) range?: '7d' | '30d' | '12m';
}

class TrendRangeDto {
  @IsOptional() @IsIn(['7d', '30d', '90d', '12m', 'year']) range?: '7d' | '30d' | '90d' | '12m' | 'year';
}

class LocationsQueryDto {
  @IsOptional() @IsIn(['7d', '30d', '90d']) range?: '7d' | '30d' | '90d';
  @IsOptional() @IsIn(['city', 'country']) group?: 'city' | 'country';
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
  visit(@Body() body: VisitDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    // The IP only places the visit on the dashboard map; it is not stored.
    return this.analytics.recordVisit(body.visitorId, ip, {
      referrer: body.referrer,
      utmSource: body.utmSource,
      utmMedium: body.utmMedium,
      userAgent,
    });
  }

  @SellerOnly()
  @RequireFeature('seller-analytics')
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

  @RequirePermissions('analytics.view')
  @Get('audiences')
  audiences() {
    return this.analytics.audiences();
  }

  /** Where visits came from: the busiest cities or countries over a range. */
  @Get('locations')
  locations(@Query() query: LocationsQueryDto) {
    return this.analytics.locations(query.range ?? '30d', query.group ?? 'city');
  }

  /** Visits by where they came from (Google, Instagram, Direct…). */
  @Get('traffic-sources')
  trafficSources(@Query() query: TrafficQueryDto) {
    return this.analytics.trafficSourcesReport(query.range ?? '7d');
  }

  /** The newest sign-ups, buyers and sellers. */
  @Get('recent-signups')
  recentSignups(@Query() query: RecentSignupsDto) {
    return this.analytics.recentSignups(query.limit ?? 20);
  }

  @Get('trends/:id')
  trend(@Param() params: TrendParamDto, @Query() query: TrendRangeDto) {
    return this.analytics.trend(params.id, query.range ?? '30d');
  }
}
