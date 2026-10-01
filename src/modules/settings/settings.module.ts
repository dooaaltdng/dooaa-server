import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminSettingsController } from './admin-settings.controller';
import { SettingsController } from './settings.controller';
import { SettingsRecord, SettingsRecordSchema } from './settings.schema';
import { SettingsService } from './settings.service';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: SettingsRecord.name, schema: SettingsRecordSchema }])],
  controllers: [SettingsController, AdminSettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
