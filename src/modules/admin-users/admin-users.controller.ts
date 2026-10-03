import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentStaff, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { ACCOUNT_STATUSES, MODERATED_STATUSES, type AccountStatus, type ModeratedStatus } from '../../common/domain';
import { PageQueryDto } from '../../common/util/pagination';
import { ToArray, Trim } from '../../common/util/transforms';
import { AdminUsersService } from './admin-users.service';

class UsersQueryDto extends PageQueryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) joinedFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) joinedTo?: string;
  /** Purchases for buyers, active listings for sellers. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minCount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) maxCount?: number;
  @IsOptional() @ToArray() @IsArray() @IsString({ each: true }) regions?: string[];
  @IsOptional() @ToArray() @IsArray() @IsIn(ACCOUNT_STATUSES, { each: true }) statuses?: AccountStatus[];
}

class ConsoleSearchDto {
  @Trim() @IsString() @MaxLength(80) q: string;
}

class StatusDto {
  @IsIn(MODERATED_STATUSES) status: ModeratedStatus;
  @IsOptional() @Trim() @IsString() @MaxLength(500) reason?: string;
}

class ListingLimitDto {
  /** Null lifts the limit. */
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'Enter a whole number of listings.' })
  @Min(0)
  @Max(10_000)
  limit: number | null;
}

class ChangeEmailDto {
  @Trim() @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email: string;
}

@ApiTags('Admin · Users')
@StaffOnly()
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  /** The topbar search across accounts, listings, transactions and disputes. */
  @Get('search')
  search(@Query() query: ConsoleSearchDto) {
    return this.users.search(query.q ?? '');
  }

  @Get('buyers')
  buyers(@Query() query: UsersQueryDto) {
    return this.users.listBuyers(query);
  }

  @Get('sellers')
  sellers(@Query() query: UsersQueryDto) {
    return this.users.listSellers(query);
  }

  @Get('buyers/:id')
  buyer(@Param('id', ObjectIdPipe) id: string) {
    return this.users.buyerProfile(id);
  }

  @Get('sellers/:id')
  seller(@Param('id', ObjectIdPipe) id: string) {
    return this.users.sellerProfile(id);
  }

  /** "Verify seller manually". */
  @HttpCode(200)
  @Post('sellers/:id/verify')
  verify(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string) {
    return this.users.verifyManually(staff, id);
  }

  /** "Limit seller listing". */
  @Patch('sellers/:id/listing-limit')
  listingLimit(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: ListingLimitDto) {
    return this.users.setListingLimit(staff, id, body.limit ?? null);
  }

  /** "Change buyer/seller email". */
  @Patch('users/:id/email')
  email(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: ChangeEmailDto) {
    return this.users.changeEmail(staff, id, body.email);
  }

  /** Suspend, ban, put under review or restore. Permission depends on the action. */
  @Patch('users/:id/status')
  status(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: StatusDto) {
    return this.users.setStatus(staff, id, body.status, body.reason);
  }
}
