import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { CurrentStaff, Public, RequirePermissions, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { Trim } from '../../common/util/transforms';
import { ContentService } from './content.service';

class PublishDto {
  @IsString() @MinLength(1, { message: 'The page cannot be empty.' }) @MaxLength(200_000) body: string;
  @IsOptional() @Trim() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(300) summary?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(200) note?: string;
}

/** Published pages for the storefront (About, Help, Terms, Privacy, Refunds, Safety). */
@ApiTags('Content')
@Public()
@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  list() {
    return this.content.list();
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.content.get(slug);
  }
}

@ApiTags('Admin · Content')
@StaffOnly()
@Controller('admin/content')
export class AdminContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  list() {
    return this.content.list();
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.content.get(slug);
  }

  @Get(':slug/history')
  history(@Param('slug') slug: string) {
    return this.content.history(slug);
  }

  @RequirePermissions('content.publish')
  @HttpCode(200)
  @Post(':slug/publish')
  publish(@CurrentStaff() staff: AuthStaff, @Param('slug') slug: string, @Body() body: PublishDto) {
    return this.content.publish(staff, slug, body);
  }

  @RequirePermissions('content.publish')
  @HttpCode(200)
  @Post(':slug/versions/:versionId/restore')
  restore(@CurrentStaff() staff: AuthStaff, @Param('slug') slug: string, @Param('versionId', ObjectIdPipe) versionId: string) {
    return this.content.restore(staff, slug, versionId);
  }
}
