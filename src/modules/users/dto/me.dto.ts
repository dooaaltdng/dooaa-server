import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CLOSE_REASONS, GENDERS, type Gender } from '../../../common/domain';
import { Trim } from '../../../common/util/transforms';
import { IsPersonName, IsPhoneNumber, IsStrongPassword } from '../../../common/util/validators';
import { OTP_CHANNELS, type OtpChannel } from '../../otp/otp.schema';

export class UpdateProfileDto {
  @IsOptional() @Trim() @IsPersonName('First name') firstName?: string;
  @IsOptional() @Trim() @IsPersonName('Last name') lastName?: string;
  @IsOptional() @Trim() @IsPhoneNumber() phone?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(60) location?: string;
  @IsOptional() @IsIn(GENDERS) gender?: Gender;
  /** Seller profile, shown on listings and in chat. */
  @IsOptional() @Trim() @IsString() @MaxLength(80) storeName?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) dispatchDays?: number;
  @IsOptional() @Trim() @IsString() @MaxLength(80) responseLabel?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(120) deliveryLabel?: string;
}

export class AvatarDto {
  @IsUrl({ require_tld: false, require_protocol: true }) url: string;
}

export class NotificationPrefsDto {
  @IsOptional() @IsBoolean() email?: boolean;
  @IsOptional() @IsBoolean() deals?: boolean;
  @IsOptional() @IsBoolean() sms?: boolean;
  @IsOptional() @IsBoolean() messages?: boolean;
  @IsOptional() @IsBoolean() feedback?: boolean;
  @IsOptional() @IsBoolean() web?: boolean;
}

export class PasswordCodeDto {
  @IsOptional() @IsIn(OTP_CHANNELS) channel?: OtpChannel;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1, { message: 'Enter your current password.' }) @MaxLength(128) currentPassword: string;
  @IsStrongPassword() newPassword: string;
  @Trim() @Matches(/^\d{6}$/, { message: 'Enter all 6 digits.' }) code: string;
}

export class CloseAccountDto {
  @IsIn(CLOSE_REASONS, { message: 'Choose a reason so we know how to improve.' }) reason: string;
  @IsOptional() @Trim() @IsString() @MaxLength(1000) notes?: string;
  @IsString() @MinLength(1, { message: 'Enter your password to confirm.' }) @MaxLength(128) password: string;
}
