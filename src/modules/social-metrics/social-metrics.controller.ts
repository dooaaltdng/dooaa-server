import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { SOCIAL_PLATFORMS, type SocialPlatform } from '../../database/schema';
import { SocialMetricsService } from './social-metrics.service';

class PlatformParamDto {
  @IsIn(SOCIAL_PLATFORMS) platform: SocialPlatform;
}

class RecordSocialDto {
  @IsInt({ message: 'Enter a whole number of followers.' }) @Min(0) @Max(10_000_000_000) followers: number;
  @IsUrl({ require_protocol: true }, { message: 'Enter the full link, starting with https://' }) @MaxLength(300) link: string;
  @IsString() @MinLength(1, { message: 'Enter the handle.' }) @MaxLength(100) handle: string;
}

@ApiTags('Admin · Social metrics')
@StaffOnly()
@Controller('admin/social-metrics')
export class SocialMetricsController {
  constructor(private readonly social: SocialMetricsService) {}

  @RequirePermissions('analytics.view')
  @Get()
  overview() {
    return this.social.overview();
  }

  @RequirePermissions('analytics.social')
  @Post(':platform')
  record(@Param() params: PlatformParamDto, @Body() body: RecordSocialDto, @CurrentStaff() staff: AuthStaff) {
    return this.social.record(params.platform, body, staff.id);
  }
}
