import { Module, OnModuleInit } from '@nestjs/common';
import { AdminContentController, ContentController } from './content.controller';
import { ContentService } from './content.service';

@Module({
  controllers: [ContentController, AdminContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule implements OnModuleInit {
  constructor(private readonly content: ContentService) {}

  async onModuleInit(): Promise<void> {
    await this.content.ensureDefaults();
  }
}
