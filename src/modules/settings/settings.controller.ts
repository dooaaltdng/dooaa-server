import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { SettingsService } from './settings.service';

@ApiTags('Settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Fees, windows and switches the storefront needs to render checkout and policy copy. */
  @Public()
  @Get('public')
  publicSettings() {
    return this.settings.publicView();
  }
}
