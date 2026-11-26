import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentStaff, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { PageQueryDto } from '../../common/util/pagination';
import { Trim } from '../../common/util/transforms';
import { EmailToolService, type EmailMode, type EmailTarget } from './email-tool.service';

class EmailUsersQueryDto extends PageQueryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(100) search?: string;
}

class SendEmailDto {
  @IsOptional() @Trim() @IsString() @MaxLength(80) campaign?: string;
  @Trim() @IsString() @MinLength(1, { message: 'Add a subject.' }) @MaxLength(150) subject: string;
  @IsString() @MinLength(1, { message: 'Write a message.' }) @MaxLength(10_000) message: string;
  @IsIn(['test', 'live']) mode: EmailMode;
  @IsIn(['one', 'selected', 'all']) target: EmailTarget;
  @IsOptional() @IsArray() @ArrayMaxSize(5_000) @IsString({ each: true }) userIds?: string[];
}

@ApiTags('Admin · Email tool')
@StaffOnly()
@Controller('admin/email')
export class EmailToolController {
  constructor(private readonly tool: EmailToolService) {}

  @Get('users')
  users(@Query() query: EmailUsersQueryDto) {
    return this.tool.users(query);
  }

  @Get('logs')
  logs(@Query() query: PageQueryDto) {
    return this.tool.logs(query);
  }

  @Delete('logs')
  clearLogs() {
    return this.tool.clearLogs();
  }

  @Delete('logs/:lineId')
  deleteLog(@Param('lineId') lineId: string) {
    return this.tool.deleteLog(lineId);
  }

  @Post('send')
  @HttpCode(200)
  send(@CurrentStaff() staff: AuthStaff, @Body() body: SendEmailDto) {
    return this.tool.send(staff, body);
  }
}
