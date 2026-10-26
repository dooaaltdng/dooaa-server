import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CLOSE_REASONS, type Gender, GENDERS, OTP_CHANNELS, type OtpChannel } from '../../../common/domain';
import { Trim } from '../../../common/util/transforms';
import { IsPersonName, IsPhoneNumber, IsStrongPassword } from '../../../common/util/validators';

export class UpdateProfileDto {
  /** Full name, as one field; stored as first name + the rest. */
  @IsOptional() @Trim() @IsString() @MinLength(2, { message: 'Enter your full name.' }) @MaxLength(100) @Matches(/^[\p{L}][\p{L}\p{M}'’. -]*$/u, { message: 'Use letters only in your name.' }) name?: string;
  @IsOptional() @Trim() @IsPersonName('First name') firstName?: string;
  @IsOptional() @Trim() @IsPersonName('Last name') lastName?: string;
  @IsOptional() @Trim() @IsPhoneNumber() phone?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(120) location?: string;
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
  /** The 6-digit code from POST /me/close/code — sign-in is passwordless, so the email confirms it. */
  @IsString() @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your email.' }) code: string;
}
