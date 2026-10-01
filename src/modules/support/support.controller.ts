import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { AllowRestricted, CurrentStaff, CurrentUser, OptionalAuth, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { SUPPORT_TOPICS } from '../../common/domain';
import { PageQueryDto } from '../../common/util/pagination';
import { ToLowerTrim, Trim } from '../../common/util/transforms';
import { SupportService } from './support.service';

class TicketDto {
  @IsIn(SUPPORT_TOPICS, { message: 'Choose what this is about.' }) topic: string;
  @Trim() @IsString() @MinLength(20, { message: 'Tell us a little more so we can help.' }) @MaxLength(5000) detail: string;
  @IsOptional() @Trim() @IsString() @MaxLength(40) orderId?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) email?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUrl({ require_tld: false, require_protocol: true }, { each: true }) attachments?: string[];
}

class TicketQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['open', 'resolved']) status?: 'open' | 'resolved';
}

class TicketStatusDto {
  @IsIn(['open', 'resolved']) status: 'open' | 'resolved';
}

@ApiTags('Support')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** The Contact page form. */
  @OptionalAuth()
  @AllowRestricted()
  @AuthThrottle()
  @Post('tickets')
  create(@CurrentUser() user: AuthUser | undefined, @Body() body: TicketDto) {
    return this.support.create(user, body);
  }
}

@ApiTags('Admin · Support')
@StaffOnly()
@Controller('admin/support/tickets')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query() query: TicketQueryDto) {
    return this.support.list(query);
  }

  @Patch(':id')
  status(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: TicketStatusDto) {
    return this.support.setStatus(staff, id, body.status);
  }
}
