import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentStaff, CurrentUser, RequirePermissions, RequireVerifiedEmail, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { BANK_VERIFICATION_METHODS, ID_TYPES, VERIFICATION_LEVELS, type BankVerificationMethod, type IdType, type VerificationLevel } from '../../common/domain';
import { PageQueryDto } from '../../common/util/pagination';
import { Trim } from '../../common/util/transforms';
import { VerificationService } from './verification.service';

class DocumentsDto {
  /** Media ids from uploads with purpose "kyc". */
  @IsMongoId({ message: 'Upload the front of your ID.' }) idFront: string;
  @IsOptional() @IsMongoId() idBack?: string;
  @IsMongoId({ message: 'Take your selfie.' }) selfie: string;
}

class BankDto {
  @IsIn(BANK_VERIFICATION_METHODS) method: BankVerificationMethod;
  @Trim() @Matches(/^\d{3,6}$/, { message: 'Choose a bank from the list.' }) bankCode: string;
  @Trim() @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number.' }) accountNumber: string;
}

class SubmitVerificationDto {
  @IsIn(ID_TYPES, { message: 'Choose the type of ID.' }) idType: IdType;
  @ValidateNested() @Type(() => DocumentsDto) documents: DocumentsDto;
  @IsBoolean() livenessPassed: boolean;
  @IsOptional() @ValidateNested() @Type(() => BankDto) bank?: BankDto;
  @IsArray() @ArrayMaxSize(5) @IsBoolean({ each: true }) consents: boolean[];
}

class VerificationQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected']) status?: 'pending' | 'approved' | 'rejected';
}

class ApproveDto {
  @IsOptional() @IsIn(VERIFICATION_LEVELS) level?: VerificationLevel;
}

class RejectDto {
  @Trim() @IsString() @MinLength(5, { message: 'Tell the user what to fix.' }) @MaxLength(500) reason: string;
}

class LevelDto {
  @IsIn(VERIFICATION_LEVELS) level: VerificationLevel;
}

@ApiTags('Account · Verification')
@Controller('me/verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  mine(@CurrentUser() user: AuthUser) {
    return this.verification.mine(user);
  }

  @RequireVerifiedEmail()
  @Post()
  submit(@CurrentUser() user: AuthUser, @Body() body: SubmitVerificationDto) {
    return this.verification.submit(user, body);
  }
}

@ApiTags('Admin · Verification')
@StaffOnly()
@Controller('admin')
export class AdminVerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('verifications')
  list(@Query() query: VerificationQueryDto) {
    return this.verification.list(query);
  }

  @Get('verifications/:id')
  get(@Param('id', ObjectIdPipe) id: string) {
    return this.verification.get(id);
  }

  @RequirePermissions('users.verify')
  @HttpCode(200)
  @Post('verifications/:id/approve')
  approve(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: ApproveDto) {
    return this.verification.approve(staff, id, body.level);
  }

  @RequirePermissions('users.verify')
  @HttpCode(200)
  @Post('verifications/:id/reject')
  reject(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: RejectDto) {
    return this.verification.reject(staff, id, body.reason);
  }

  @RequirePermissions('users.verify')
  @Patch('sellers/:id/verification-level')
  level(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: LevelDto) {
    return this.verification.setLevel(staff, id, body.level);
  }
}
