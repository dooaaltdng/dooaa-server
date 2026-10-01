import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { AuditService } from '../audit/audit.service';
import { JobsService } from './jobs.service';

@ApiTags('Admin · System')
@StaffOnly()
@Controller('admin/system')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  /** Runs the background jobs now (they also run on a timer). */
  @RequirePermissions('settings.manage')
  @HttpCode(200)
  @Post('jobs/run')
  async run(@CurrentStaff() staff: AuthStaff) {
    const result = await this.jobs.runAll();
    await this.audit.record(staff, { action: 'Ran background jobs', target: 'Payments & escrow', targetType: 'system' });
    return result;
  }
}
