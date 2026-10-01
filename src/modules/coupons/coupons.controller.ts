import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { Trim } from '../../common/util/transforms';
import { CouponsService } from './coupons.service';

class CouponDto {
  @Trim() @Matches(/^[A-Za-z0-9_-]{3,24}$/, { message: 'Codes are 3–24 letters, numbers, dashes or underscores.' }) code: string;
  @IsOptional() @Trim() @IsString() @MaxLength(120) description?: string;
  @IsIn(['percent', 'fixed']) type: 'percent' | 'fixed';
  @IsNumber() @Min(0) value: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Date) @IsDate() startsAt?: Date;
  @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
}

class UpdateCouponDto {
  @IsOptional() @Trim() @IsString() @MaxLength(120) description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @IsOptional() @IsNumber() @Min(0) minSubtotal?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Date) @IsDate() startsAt?: Date;
  @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
}

@ApiTags('Admin · Coupons')
@StaffOnly()
@Controller('admin/coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  list() {
    return this.coupons.list();
  }

  @RequirePermissions('settings.manage')
  @Post()
  create(@CurrentStaff() staff: AuthStaff, @Body() body: CouponDto) {
    return this.coupons.create(staff, body);
  }

  @RequirePermissions('settings.manage')
  @Patch(':code')
  update(@CurrentStaff() staff: AuthStaff, @Param('code') code: string, @Body() body: UpdateCouponDto) {
    return this.coupons.update(staff, code, body);
  }
}
