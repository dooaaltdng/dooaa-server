import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentStaff, CurrentUser, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { DISPUTE_OUTCOMES, DISPUTE_STATES, type DisputeOutcome, type DisputeState } from '../../common/domain';
import { ToArray, Trim } from '../../common/util/transforms';
import { DisputesService } from './disputes.service';

const URL = { require_tld: false, require_protocol: true };

class OpenDisputeDto {
  @Trim() @IsString() @MinLength(10, { message: 'Describe what went wrong.' }) @MaxLength(2000) reason: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsUrl(URL, { each: true }) evidence?: string[];
}

class RespondDto {
  @Trim() @IsString() @MinLength(10, { message: 'Tell us your side.' }) @MaxLength(2000) claim: string;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsUrl(URL, { each: true }) evidence?: string[];
}

class DisputeQueryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @ToArray() @IsArray() @IsIn(DISPUTE_STATES, { each: true }) states?: DisputeState[];
  @IsOptional() @ToArray() @IsArray() @IsIn(DISPUTE_OUTCOMES, { each: true }) outcomes?: DisputeOutcome[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) openedFrom?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) openedTo?: string;
}

class DisputeMessageDto {
  @Trim() @IsString() @MinLength(1, { message: 'Write a message.' }) @MaxLength(2000) body: string;
  @IsOptional() @IsUrl(URL) image?: string;
}

class ReopenDto {
  @IsOptional() @Trim() @IsString() @MaxLength(1000) note?: string;
}

class ResolveDto {
  @IsIn(DISPUTE_OUTCOMES) outcome: DisputeOutcome;
  @IsOptional() @Trim() @IsString() @MaxLength(1000) note?: string;
}

@ApiTags('Disputes')
@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  /** "Report" from the order or the thread: freezes the payment until DOOAA rules. */
  @Post('orders/:id/dispute')
  open(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: OpenDisputeDto) {
    return this.disputes.open(user, id, body);
  }

  @Get('disputes')
  mine(@CurrentUser() user: AuthUser) {
    return this.disputes.mine(user);
  }

  @Get('disputes/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.disputes.get(user, id);
  }

  @HttpCode(200)
  @Post('disputes/:id/respond')
  respond(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string, @Body() body: RespondDto) {
    return this.disputes.respond(user, id, body);
  }
}

@ApiTags('Admin · Disputes')
@StaffOnly()
@Controller('admin/disputes')
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  list(@Query() query: DisputeQueryDto) {
    return this.disputes.adminList(query);
  }

  @Get(':id')
  get(@Param('id', ObjectIdPipe) id: string) {
    return this.disputes.adminGet(id);
  }

  @Post(':id/messages')
  message(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: DisputeMessageDto) {
    return this.disputes.postMessage(staff, id, body.body, body.image);
  }

  @RequirePermissions('disputes.rule')
  @HttpCode(200)
  @Post(':id/resolve')
  resolve(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: ResolveDto) {
    return this.disputes.resolve(staff, id, body.outcome, body.note);
  }

  /** Brings back a dispute that was closed without action. */
  @RequirePermissions('disputes.rule')
  @HttpCode(200)
  @Post(':id/reopen')
  reopen(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: ReopenDto) {
    return this.disputes.reopen(staff, id, body.note);
  }
}
