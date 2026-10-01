import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { PageQueryDto } from '../../common/util/pagination';
import { AuditService } from '../audit/audit.service';
import { InviteStaffDto, UpdateStaffRoleDto } from './dto/staff.dto';
import { StaffService } from './staff.service';

class AuditQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(40) targetType?: string;
}

@ApiTags('Admin · Team')
@StaffOnly()
@Controller('admin')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly audit: AuditService,
  ) {}

  @Get('staff')
  list() {
    return this.staff.list();
  }

  @RequirePermissions('settings.manage')
  @Post('staff/invite')
  invite(@CurrentStaff() actor: AuthStaff, @Body() body: InviteStaffDto) {
    return this.staff.invite(actor, body);
  }

  @RequirePermissions('settings.manage')
  @Patch('staff/:id/role')
  updateRole(@CurrentStaff() actor: AuthStaff, @Param('id', ObjectIdPipe) id: string, @Body() body: UpdateStaffRoleDto) {
    return this.staff.updateRole(actor, id, body.role);
  }

  @RequirePermissions('settings.manage')
  @HttpCode(200)
  @Post('staff/:id/disable')
  disable(@CurrentStaff() actor: AuthStaff, @Param('id', ObjectIdPipe) id: string) {
    return this.staff.setDisabled(actor, id, true);
  }

  @RequirePermissions('settings.manage')
  @HttpCode(200)
  @Post('staff/:id/restore')
  restore(@CurrentStaff() actor: AuthStaff, @Param('id', ObjectIdPipe) id: string) {
    return this.staff.setDisabled(actor, id, false);
  }

  /** "Permissions say who may; this says who did." */
  @Get('audit')
  auditLog(@Query() query: AuditQueryDto) {
    return this.audit.list({ page: query.page, limit: query.limit, search: query.search, targetType: query.targetType });
  }
}
