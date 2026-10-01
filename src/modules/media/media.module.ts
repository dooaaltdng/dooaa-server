import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { AdminMediaController, MediaController } from './media.controller';
import { Media, MediaSchema } from './media.schema';
import { MediaService } from './media.service';
import { CloudinaryStorage } from './storage/cloudinary.storage';
import { LocalStorage } from './storage/local.storage';
import { MemoryStorage } from './storage/memory.storage';
import { STORAGE_DRIVER, type StorageDriver } from './storage/storage.driver';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Media.name, schema: MediaSchema }]),
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
      useFactory: (config: AppConfig): StorageDriver => {
        if (config.storage.driver === 'cloudinary') {
          const { cloudName, apiKey, apiSecret, folder } = config.storage.cloudinary;
          return new CloudinaryStorage({ cloudName: cloudName!, apiKey: apiKey!, apiSecret: apiSecret!, folder });
        }
        if (config.storage.driver === 'local') return new LocalStorage(join(process.cwd(), config.storage.localDir), config.appUrl);
        return new MemoryStorage();
      },
    },
  ],
  exports: [MediaService],
})
export class MediaModule {}
