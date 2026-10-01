import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentStaff, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { PERMISSIONS, SUPERADMIN_ONLY, STAFF_ROLES } from '../../common/domain';
import { SectionParamDto, UpdateSettingsSectionDto } from './dto/settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('Admin · Settings')
@StaffOnly()
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Every section, plus the vocabulary the role matrix renders. */
  @Get()
  async all() {
    return {
      settings: await this.settings.get(),
      permissions: PERMISSIONS,
      superadminOnly: SUPERADMIN_ONLY,
      roles: STAFF_ROLES,
    };
  }

  @RequirePermissions('settings.manage')
  @Put(':section')
  async update(@CurrentStaff() actor: AuthStaff, @Param() params: SectionParamDto, @Body() body: UpdateSettingsSectionDto) {
    const value = await this.settings.update(params.section, body.value, actor);
    return { section: params.section, value };
  }
}
