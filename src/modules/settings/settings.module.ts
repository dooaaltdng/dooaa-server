import { Global, Module } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Global()
@Module({
  controllers: [SettingsController, AdminSettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
