import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { ESCROW_STATUSES, SETTLEMENTS, type EscrowStatus, type Settlement } from '../../common/domain';
import { PageQueryDto } from '../../common/util/pagination';
import { Trim } from '../../common/util/transforms';
import { WalletService } from '../wallet/wallet.service';
import { EscrowAdminService } from './escrow-admin.service';

class EscrowQueryDto extends PageQueryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn([...ESCROW_STATUSES, 'all']) status?: EscrowStatus | 'all';
}

class SettleDto {
  @IsIn(SETTLEMENTS) settlement: Settlement;
  @IsOptional() @Trim() @IsString() @MaxLength(500) note?: string;
}

class PayoutQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['processing', 'completed', 'failed']) status?: 'processing' | 'completed' | 'failed';
}

@ApiTags('Admin · Escrow & Payments')
@StaffOnly()
@Controller('admin')
export class AdminEscrowController {
  constructor(
    private readonly escrow: EscrowAdminService,
    private readonly wallet: WalletService,
  ) {}

  @Get('escrows')
  list(@Query() query: EscrowQueryDto) {
    return this.escrow.list(query);
  }

  @Get('escrows/:id')
  get(@Param('id', ObjectIdPipe) id: string) {
    return this.escrow.get(id);
  }

  /** Release, refund, force-release or reverse. Permission depends on the verb. */
  @HttpCode(200)
  @Post('escrows/:id/settle')
  settle(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: SettleDto) {
    return this.escrow.settle(staff, id, body.settlement, body.note);
  }

  @Get('payouts')
  payouts(@Query() query: PayoutQueryDto) {
    return this.wallet.adminPayouts(query);
  }

  @RequirePermissions('escrow.release')
  @HttpCode(200)
  @Post('payouts/:id/retry')
  retry(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string) {
    return this.wallet.retryPayout(staff, id);
  }
}
