import { Body, Controller, Delete, Get, Headers, HttpCode, Ip, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { UuidPipe } from '../../common/api/uuid.pipe';
import { CurrentUser, OptionalAuth, Public, RequireVerifiedEmail } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { BLOG_CATEGORIES, type BlogCategory } from '../../common/domain';
import { ToBoolean } from '../../common/util/transforms';
import { BlogAudienceService } from './blog-audience.service';
import { BlogCommunityService, type CommentSort } from './blog-community.service';
import { BlogService } from './blog.service';

class ListArticlesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) limit?: number;
  /** Rows to skip; takes the place of `page` for "Load More". */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
  /** The search box on /blog. */
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  /** A tag's slug (/blog/tag/:slug). */
  @IsOptional() @IsString() @MaxLength(60) tag?: string;
  @IsOptional() @IsIn(BLOG_CATEGORIES) category?: BlogCategory;
  /** The featured article's id, so later pages leave it out of the grid. */
  @IsOptional() @IsString() @MaxLength(64) exclude?: string;
  @IsOptional() @ToBoolean() featured?: boolean;
}

class CommentsQueryDto {
  @IsOptional() @IsIn(['newest', 'oldest', 'top']) sort?: CommentSort;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

class CommentDto {
  @IsString() @MinLength(1, { message: 'Write something before posting.' }) @MaxLength(4000) body: string;
  @IsOptional() @IsString() @MaxLength(64) parentId?: string;
}

class EditCommentDto {
  @IsString() @MinLength(1, { message: 'Write something before saving.' }) @MaxLength(4000) body: string;
}

class ViewDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'Invalid visitor id.' }) visitorId: string;
  @IsOptional() @IsString() @MaxLength(2048) referrer?: string;
  @IsOptional() @IsString() @MaxLength(100) utmSource?: string;
  @IsOptional() @IsString() @MaxLength(100) utmMedium?: string;
}

/** The storefront's blog: /blog and /blog/:slug, with likes, comments and reading stats. */
@ApiTags('Blog')
@Controller('blog')
export class BlogController {
  constructor(
    private readonly blog: BlogService,
    private readonly community: BlogCommunityService,
    private readonly audience: BlogAudienceService,
  ) {}

  @Public()
  @Get('articles')
  list(@Query() query: ListArticlesDto) {
    return this.blog.listPublic({ ...query, withFeatured: query.featured });
  }

  /** Categories with their live article counts. */
  @Public()
  @Get('categories')
  categories() {
    return this.blog.categories();
  }

  @Public()
  @Get('tags')
  tags() {
    return this.blog.tags();
  }

  @Public()
  @Get('sitemap')
  sitemap() {
    return this.blog.sitemap();
  }

  @OptionalAuth()
  @Get('articles/:slug')
  get(@Param('slug') slug: string, @CurrentUser() user?: AuthUser) {
    return this.blog.getPublic(slug, (articleId) => this.community.isLiked(articleId, user?.id));
  }

  /** Live counts and the reader's own like, for the article page's buttons. */
  @OptionalAuth()
  @Get('articles/:slug/engagement')
  engagement(@Param('slug') slug: string, @CurrentUser() user?: AuthUser) {
    return this.community.engagement(slug, user?.id);
  }

  @Put('articles/:slug/like')
  like(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.community.like(user, slug);
  }

  @Delete('articles/:slug/like')
  unlike(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.community.unlike(user, slug);
  }

  @OptionalAuth()
  @Get('articles/:slug/comments')
  comments(@Param('slug') slug: string, @Query() query: CommentsQueryDto, @CurrentUser() user?: AuthUser) {
    return this.community.threadBySlug(slug, query, user?.id);
  }

  @RequireVerifiedEmail()
  @Post('articles/:slug/comments')
  comment(@CurrentUser() user: AuthUser, @Param('slug') slug: string, @Body() body: CommentDto) {
    return this.community.comment(user, slug, body);
  }

  @Put('comments/:id')
  edit(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string, @Body() body: EditCommentDto) {
    return this.community.edit(user, id, body);
  }

  @Delete('comments/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.community.deleteOwn(user, id);
  }

  @Put('comments/:id/like')
  likeComment(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.community.likeComment(user, id);
  }

  @Delete('comments/:id/like')
  unlikeComment(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.community.unlikeComment(user, id);
  }

  /** Counts a read. The IP only places it on the console's region chart; it is not stored. */
  @OptionalAuth()
  @HttpCode(200)
  @Post('articles/:slug/views')
  view(@Param('slug') slug: string, @Body() body: ViewDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string, @CurrentUser() user?: AuthUser) {
    return this.audience.recordView(slug, body.visitorId, ip, { referrer: body.referrer, utmSource: body.utmSource, utmMedium: body.utmMedium, userAgent }, user?.id);
  }

  /**
   * The read beacon, sent as the reader leaves. navigator.sendBeacon posts
   * text/plain (no CORS preflight), so the JSON arrives as a string.
   */
  @Public()
  @HttpCode(200)
  @Post('views/:id/read')
  read(@Param('id') id: string, @Req() request: Request) {
    let body: unknown = request.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const input = (body && typeof body === 'object' ? body : {}) as { seconds?: unknown; completed?: unknown };
    return this.audience.recordRead(id, input);
  }
}
