import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { AdminMediaController, MediaController } from './media.controller';
import { MediaService } from './media.service';
import { CloudinaryStorage } from './storage/cloudinary.storage';
import { STORAGE_DRIVER, type StorageDriver } from './storage/storage.driver';

@Global()
@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        limits: {
          fileSize: Math.max(config.storage.maxImageMb, config.storage.maxVideoMb, config.storage.maxFileMb) * 1024 * 1024,
          files: 1,
          fields: 10,
        },
      }),
    }),
  ],
  controllers: [MediaController, AdminMediaController],
  providers: [
    MediaService,
    {
      provide: STORAGE_DRIVER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): StorageDriver => new CloudinaryStorage(config.storage.cloudinary),
    },
  ],
  exports: [MediaService],
})
export class MediaModule {}
