import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminContentController, ContentController } from './content.controller';
import { ContentPage, ContentPageSchema, ContentVersion, ContentVersionSchema } from './content.schema';
import { ContentService } from './content.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContentPage.name, schema: ContentPageSchema },
      { name: ContentVersion.name, schema: ContentVersionSchema },
    ]),
  ],
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
