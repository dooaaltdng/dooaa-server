import { Equals, IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { USER_ROLES, type UserRole } from '../../../common/domain';
import { ToLowerTrim, Trim } from '../../../common/util/transforms';
import { IsPersonName, IsPhoneNumber, IsStrongPassword } from '../../../common/util/validators';
import { OTP_CHANNELS, type OtpChannel } from '../../otp/otp.schema';

export class SignUpDto {
  @Trim() @IsPersonName('First name') firstName: string;
  @Trim() @IsPersonName('Last name') lastName: string;
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email: string;
  @Trim() @IsPhoneNumber() phone: string;
  @IsStrongPassword() password: string;
  @IsBoolean() @Equals(true, { message: 'Accept the Terms & conditions to continue.' }) acceptedTerms: boolean;
  @IsBoolean() @Equals(true, { message: 'Accept the Privacy Policy to continue.' }) acceptedPrivacy: boolean;
}

export class SignInDto {
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) email: string;
  @IsString() @MinLength(1, { message: 'Password is required.' }) @MaxLength(128) password: string;
}

export class RefreshDto {
  /** Optional when the httpOnly refresh cookie is present. */
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}

/** Codes the public auth flow can request. Signed-in flows have their own endpoints. */
export const PUBLIC_OTP_PURPOSES = ['verify-email', 'reset-password'] as const;
export type PublicOtpPurpose = (typeof PUBLIC_OTP_PURPOSES)[number];

export class SendOtpDto {
  @IsIn(PUBLIC_OTP_PURPOSES) purpose: PublicOtpPurpose;
  /** The account's email address or phone number. */
  @Trim() @IsString() @MinLength(3, { message: 'Enter your email address.' }) @MaxLength(254) identifier: string;
  @IsOptional() @IsIn(OTP_CHANNELS) channel?: OtpChannel;
}

export class VerifyOtpDto {
  @IsIn(PUBLIC_OTP_PURPOSES) purpose: PublicOtpPurpose;
  @Trim() @IsString() @MinLength(3) @MaxLength(254) identifier: string;
  @Trim() @Matches(/^\d{6}$/, { message: 'Enter all 6 digits.' }) code: string;
}

export class ForgotPasswordDto {
  @Trim() @IsString() @MinLength(3, { message: 'Enter your email address.' }) @MaxLength(254) identifier: string;
  @IsOptional() @IsIn(OTP_CHANNELS) channel?: OtpChannel;
}

export class ResetPasswordDto {
  @IsString() @Length(20, 2000) resetToken: string;
  @IsStrongPassword() password: string;
}

export class VerifyPasswordDto {
  @IsString() @MinLength(1, { message: 'Enter your password.' }) @MaxLength(128) password: string;
}

export class SetRoleDto {
  @IsIn(USER_ROLES, { message: 'Choose buyer or seller.' }) role: UserRole;
}
