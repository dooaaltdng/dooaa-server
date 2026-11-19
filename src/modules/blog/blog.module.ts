import { Module, type OnModuleInit } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminBlogController } from './admin-blog.controller';
import { BlogAudienceService } from './blog-audience.service';
import { BlogCommunityService } from './blog-community.service';
import { BlogStatsService } from './blog-stats.service';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';

@Module({
  imports: [AnalyticsModule, NotificationsModule],
  controllers: [BlogController, AdminBlogController],
  providers: [BlogService, BlogCommunityService, BlogAudienceService, BlogStatsService],
})
export class BlogModule implements OnModuleInit {
  constructor(private readonly blog: BlogService) {}

  async onModuleInit(): Promise<void> {
    await this.blog.backfillTagSlugs();
  }
}
