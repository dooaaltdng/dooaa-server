import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { RawResponse } from '../../common/api/raw-response.decorator';
import { CurrentStaff, CurrentUser, Public, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { MediaPurpose } from '../../common/domain';
import { MEDIA_KINDS, type MediaKind } from './media.schema';
import { MediaService, type UploadedFile as Upload } from './media.service';

/** Purposes a marketplace account may upload for. */
const USER_PURPOSES: MediaPurpose[] = ['product', 'avatar', 'kyc', 'message', 'evidence', 'support', 'meetup', 'shipment'];
/** Purposes the console uploads for. */
const STAFF_PURPOSES: MediaPurpose[] = ['product', 'content', 'message', 'evidence'];

class UploadBodyDto {
  @IsIn(USER_PURPOSES) purpose: MediaPurpose;
}

class StaffUploadBodyDto {
  @IsIn(STAFF_PURPOSES) purpose: MediaPurpose;
}

class StartUploadDto {
  @IsIn(USER_PURPOSES) purpose: MediaPurpose;
  @IsIn(MEDIA_KINDS) kind: MediaKind;
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(500 * 1024 * 1024) size: number;
}

class StaffStartUploadDto extends StartUploadDto {
  @IsIn(STAFF_PURPOSES) declare purpose: MediaPurpose;
}

class ConfirmUploadDto {
  @IsString() @MinLength(10) @MaxLength(4000) ticket: string;
}

class SignedQueryDto {
  @IsOptional() @IsString() expires?: string;
  @IsOptional() @IsString() sig?: string;
}

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @ApiConsumes('multipart/form-data')
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Upload, @Body() body: UploadBodyDto) {
    return this.media.upload(file, body.purpose, { id: user.id, type: 'user' });
  }

  /** Step 1 of a direct upload: signed fields for the browser to post the file straight to Cloudinary. */
  @Post('uploads')
  startDirect(@CurrentUser() user: AuthUser, @Body() body: StartUploadDto) {
    return this.media.startDirectUpload(body, { id: user.id, type: 'user' });
  }

  /** Step 2: register the uploaded object once Cloudinary confirms its format and size. */
  @Post('uploads/confirm')
  confirmDirect(@CurrentUser() user: AuthUser, @Body() body: ConfirmUploadDto) {
    return this.media.confirmDirectUpload(body.ticket, { id: user.id, type: 'user' });
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.media.remove(id, { id: user.id, type: 'user' });
  }

  /** Public files on drivers without a CDN, and signed links to private files. */
  @Public()
  @RawResponse()
  @Get(':id/content')
  async content(@Param('id', ObjectIdPipe) id: string, @Query() query: SignedQueryDto, @Res() response: Response) {
    const { media, object } = await this.media.read(id, { expires: Number(query.expires), sig: query.sig });
    if ('redirect' in object) return response.redirect(302, object.redirect);
    response.setHeader('Content-Type', object.contentType);
    response.setHeader('Content-Length', String(object.body.length));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', media.visibility === 'private' ? 'private, no-store' : 'public, max-age=604800, immutable');
    if (media.kind === 'file') response.setHeader('Content-Disposition', `inline; filename="${media.name.replace(/"/g, '')}"`);
    response.end(object.body);
  }
}

@ApiTags('Admin · Media')
@StaffOnly()
@Controller('admin/media')
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @ApiConsumes('multipart/form-data')
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@CurrentStaff() staff: AuthStaff, @UploadedFile() file: Upload, @Body() body: StaffUploadBodyDto) {
    return this.media.upload(file, body.purpose, { id: staff.id, type: 'staff' });
  }

  @Post('uploads')
  startDirect(@CurrentStaff() staff: AuthStaff, @Body() body: StaffStartUploadDto) {
    return this.media.startDirectUpload(body, { id: staff.id, type: 'staff' });
  }

  @Post('uploads/confirm')
  confirmDirect(@CurrentStaff() staff: AuthStaff, @Body() body: ConfirmUploadDto) {
    return this.media.confirmDirectUpload(body.ticket, { id: staff.id, type: 'staff' });
  }
}

