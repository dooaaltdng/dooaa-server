import { IsEmail, IsIn, IsOptional, IsString, IsUrl, Length, MaxLength, MinLength } from 'class-validator';
import { STAFF_ROLES, type StaffRole } from '../../../common/domain';
import { ToLowerTrim, Trim } from '../../../common/util/transforms';
import { IsPersonName, IsStrongPassword } from '../../../common/util/validators';

export class StaffSignInDto {
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid work email address.' }) email: string;
  @IsString() @MinLength(1, { message: 'Password is required.' }) @MaxLength(128) password: string;
}

export class StaffRefreshDto {
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}

export class InviteStaffDto {
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid work email address.' }) email: string;
  @Trim() @IsPersonName('First name') firstName: string;
  @Trim() @IsPersonName('Last name') lastName: string;
  @IsIn(STAFF_ROLES) role: StaffRole;
  @IsOptional() @Trim() @IsString() @MaxLength(60) title?: string;
}

export class AcceptInviteDto {
  @IsString() @Length(20, 200) token: string;
  @IsStrongPassword() password: string;
}

export class UpdateStaffRoleDto {
  @IsIn(STAFF_ROLES) role: StaffRole;
}

export class ChangeStaffPasswordDto {
  @IsString() @MinLength(1, { message: 'Enter your current password.' }) @MaxLength(128) currentPassword: string;
  @IsStrongPassword() newPassword: string;
}

export class StaffForgotPasswordDto {
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) email: string;
}

export class StaffVerifyResetCodeDto {
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) email: string;
  @IsString() @Length(6, 6, { message: 'Enter the 6-digit code.' }) code: string;
}

export class StaffResetPasswordDto {
  @IsString() @Length(20, 200) token: string;
  @IsStrongPassword() password: string;
}

/** The only profile fields staff may change about themselves. */
export class UpdateStaffProfileDto {
  @Trim() @IsPersonName('First name') firstName: string;
  @Trim() @IsPersonName('Last name') lastName: string;
}

export class StaffAvatarDto {
  @IsUrl({ require_tld: false, require_protocol: true }) url: string;
}
