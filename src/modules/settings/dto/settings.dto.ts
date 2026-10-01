import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PERMISSIONS, type Permission } from '../../../common/domain';

export class EscrowSettingsDto {
  @IsBoolean() enabled: boolean;
  @IsNumber() @Min(0) @Max(20) feePercent: number;
  @IsNumber() @Min(0) @Max(1_000_000) minimumFee: number;
  @IsNumber() @Min(1) @Max(60) autoReleaseDays: number;
  @IsArray() @ArrayUnique() @IsString({ each: true }) @MaxLength(40, { each: true }) payoutMethods: string[];
}

export class DisputeSettingsDto {
  @IsNumber() @Min(1) @Max(240) responseHours: number;
  @IsNumber() @Min(0) @Max(90) reopenDays: number;
  @IsNumber() @Min(1) @Max(90) returnWindowDays: number;
  @IsNumber() @Min(1) @Max(120) nonDeliveryWindowDays: number;
  @IsString() @Matches(/^\d{1,2}(\s*[–-]\s*\d{1,2})?$/, { message: 'settlementDays reads like "3–5".' }) settlementDays: string;
}

export class ModerationSettingsDto {
  @IsBoolean() autoPublishListings: boolean;
  @IsArray() @ArrayUnique() @IsString({ each: true }) reviewCategories: string[];
  @IsNumber() @Min(1) @Max(100) suspiciousPriceMultiple: number;
  @IsNumber() @Min(0) requireKycAboveAmount: number;
}

export class MarketplaceSettingsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true }) activeCategories: string[];
  @IsArray() @ArrayUnique() @IsString({ each: true }) @MaxLength(60, { each: true }) regions: string[];
}

export class NotificationSettingsDto {
  @IsBoolean() newDispute: boolean;
  @IsBoolean() suspiciousListing: boolean;
  @IsBoolean() highValueTransaction: boolean;
  @IsBoolean() kycSubmission: boolean;
  @IsNumber() @Min(0) highValueThreshold: number;
}

export class RolesSettingsDto {
  @IsArray() @ArrayUnique() @IsIn(PERMISSIONS, { each: true }) superadmin: Permission[];
  @IsArray() @ArrayUnique() @IsIn(PERMISSIONS, { each: true }) admin: Permission[];
  @IsArray() @ArrayUnique() @IsIn(PERMISSIONS, { each: true }) moderator: Permission[];
}

export class CommerceSettingsDto {
  @IsNumber() @Min(0) @Max(1_000_000) deliveryFee: number;
  @IsNumber() @Min(0) @Max(1_000_000) escrowDeliveryFee: number;
  @IsNumber() @Min(0) @Max(50) taxRate: number;
  @IsNumber() @Min(0) @Max(50) commissionPercent: number;
  @IsNumber() @Min(0) minimumWithdrawal: number;
  @IsNumber() @Min(1) @Max(720) shipWithinHours: number;
  @IsNumber() @Min(0) @Max(60) deliveryEstimateDays: number;
  @IsNumber() @Min(5) @Max(10_080) unpaidOrderTtlMinutes: number;
  @IsBoolean() autoPayout: boolean;
}

export const SECTION_DTO = {
  escrow: EscrowSettingsDto,
  disputes: DisputeSettingsDto,
  moderation: ModerationSettingsDto,
  marketplace: MarketplaceSettingsDto,
  notifications: NotificationSettingsDto,
  roles: RolesSettingsDto,
  commerce: CommerceSettingsDto,
} as const;

/** Body of `PUT /admin/settings/:section` — the section's full value. */
export class UpdateSettingsSectionDto {
  @IsObject() value: Record<string, unknown>;
}

export class SectionParamDto {
  @IsIn(Object.keys(SECTION_DTO)) section: keyof typeof SECTION_DTO;
}

