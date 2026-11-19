import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { UuidPipe } from '../../common/api/uuid.pipe';
import { CurrentStaff, RequireAnyPermission, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { BLOG_CATEGORIES, BLOG_LINE_SPACING, BLOG_TEXT_SIZE, BLOG_THEMES, type BlogCategory, type BlogState, type BlogTheme } from '../../common/domain';
import { ToBoolean } from '../../common/util/transforms';
import { BlogCommunityService, type CommentSort } from './blog-community.service';
import { BlogStatsService, type BlogRange } from './blog-stats.service';
import { BlogService } from './blog.service';

class ArticleDto {
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(400_000) body?: string;
  @IsOptional() @IsString() @MaxLength(300) excerpt?: string;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsString() @MaxLength(2048) coverUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(200) coverAlt?: string;
  @IsOptional() @IsIn(BLOG_CATEGORIES) category?: BlogCategory;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @IsOptional() @IsString() @MaxLength(200) seoTitle?: string;
  @IsOptional() @IsString() @MaxLength(400) seoDescription?: string;
  @IsOptional() @IsIn(BLOG_THEMES) theme?: BlogTheme;
  @IsOptional() @IsNumber() @Min(BLOG_TEXT_SIZE.min) @Max(BLOG_TEXT_SIZE.max) textSize?: number;
  @IsOptional() @IsNumber() @Min(BLOG_LINE_SPACING.min) @Max(BLOG_LINE_SPACING.max) lineSpacing?: number;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsString() @MinLength(1, { message: 'The link cannot be empty.' }) @MaxLength(90) slug?: string;
  @IsOptional() @IsString() @MaxLength(64) authorId?: string;
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsISO8601({}, { message: 'That date is not valid.' }) publishedAt?: string | null;
}

class PublishDto {
  /** Omitted: the date already on the article, or now. Null: now. A date ahead schedules it. */
  @IsOptional() @ValidateIf((_, value) => value !== null) @IsISO8601({}, { message: 'That date is not valid.' }) publishAt?: string | null;
}

class ListDto {
  @IsOptional() @IsIn(['all', 'draft', 'scheduled', 'published', 'trash']) status?: 'all' | BlogState | 'trash';
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @ToBoolean() @IsBoolean() mine?: boolean;
  @IsOptional() @IsIn(BLOG_CATEGORIES) category?: BlogCategory;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

class OverviewDto {
  @IsOptional() @IsIn(['7d', '30d', '90d', '12m']) range?: BlogRange;
  @IsOptional() @IsIn(BLOG_CATEGORIES) category?: BlogCategory;
}

class CalendarDto {
  @IsString() month: string;
}

class CommentsDto {
  @IsOptional() @IsIn(['newest', 'oldest', 'top']) sort?: CommentSort;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

class StaffCommentDto {
  @IsString() @MinLength(1, { message: 'Write something before posting.' }) @MaxLength(4000) body: string;
  @IsOptional() @IsString() @MaxLength(64) parentId?: string;
}

/**
 * The console's blog. Reading it takes either blog permission; writing,
 * publishing and the trash take `blog.write`; removing readers' comments
 * takes `blog.moderate`.
 */
@ApiTags('Admin · Blog')
@StaffOnly()
@Controller('admin/blog')
export class AdminBlogController {
  constructor(
    private readonly blog: BlogService,
    private readonly community: BlogCommunityService,
    private readonly stats: BlogStatsService,
  ) {}

  /** The editor's options: categories, themes, slider ranges and authors. */
  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Get('meta')
  async meta() {
    return {
      categories: this.stats.categories(),
      themes: BLOG_THEMES,
      textSize: BLOG_TEXT_SIZE,
      lineSpacing: BLOG_LINE_SPACING,
      authors: await this.blog.authorOptions(),
      // Future feature (dooaa-admin FUTURE-FEATURES.md, "AI rewrite in the blog editor"):
      // assistant: Boolean(config.anthropicApiKey),
    };
  }

  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Get('overview')
  overview(@Query() query: OverviewDto) {
    return this.stats.overview(query.range ?? '30d', query.category ?? null);
  }

  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Get('calendar')
  calendar(@Query() query: CalendarDto) {
    return this.stats.calendar(query.month);
  }

  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Get('articles')
  list(@CurrentStaff() staff: AuthStaff, @Query() query: ListDto) {
    return this.blog.list(staff, query);
  }

  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Get('articles/:id')
  get(@Param('id', UuidPipe) id: string) {
    return this.blog.get(id);
  }

  @RequirePermissions('blog.write')
  @Post('articles')
  create(@CurrentStaff() staff: AuthStaff, @Body() body: ArticleDto) {
    return this.blog.create(staff, body);
  }

  @RequirePermissions('blog.write')
  @Patch('articles/:id')
  update(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string, @Body() body: ArticleDto) {
    return this.blog.update(staff, id, body);
  }

  @RequirePermissions('blog.write')
  @HttpCode(200)
  @Post('articles/:id/publish')
  publish(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string, @Body() body: PublishDto) {
    return this.blog.publish(staff, id, body);
  }

  @RequirePermissions('blog.write')
  @HttpCode(200)
  @Post('articles/:id/unpublish')
  unpublish(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string) {
    return this.blog.unpublish(staff, id);
  }

  @RequirePermissions('blog.write')
  @Delete('articles/:id')
  trash(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string) {
    return this.blog.trash(staff, id);
  }

  @RequirePermissions('blog.write')
  @HttpCode(200)
  @Post('articles/:id/restore')
  restore(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string) {
    return this.blog.restore(staff, id);
  }

  @RequirePermissions('blog.write')
  @Delete('articles/:id/permanent')
  purge(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string) {
    return this.blog.purge(staff, id);
  }

  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Get('articles/:id/comments')
  comments(@Param('id', UuidPipe) id: string, @Query() query: CommentsDto) {
    return this.community.threadForConsole(id, query);
  }

  /** The team replies to readers (or starts a thread) from the console. */
  @RequireAnyPermission('blog.write', 'blog.moderate')
  @Post('articles/:id/comments')
  reply(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string, @Body() body: StaffCommentDto) {
    return this.community.staffComment(staff, id, body);
  }

  @RequirePermissions('blog.moderate')
  @Delete('comments/:id')
  removeComment(@CurrentStaff() staff: AuthStaff, @Param('id', UuidPipe) id: string) {
    return this.community.moderate(staff, id);
  }
}
