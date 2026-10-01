import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AllowRestricted, CurrentUser, RequestMeta, type RequestMetaValue } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { AvatarDto, ChangePasswordDto, CloseAccountDto, NotificationPrefsDto, PasswordCodeDto, UpdateProfileDto } from './dto/me.dto';
import { MeService } from './me.service';

/** Profile & Settings. */
@ApiTags('Account')
@ApiBearerAuth('user')
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @AllowRestricted()
  @Get()
  profile(@CurrentUser() user: AuthUser) {
    return this.me.profile(user);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileDto) {
    return this.me.update(user, body);
  }

  @Put('avatar')
  setAvatar(@CurrentUser() user: AuthUser, @Body() body: AvatarDto) {
    return this.me.setAvatar(user, body.url);
  }

  @Delete('avatar')
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.me.removeAvatar(user);
  }

  @Patch('notification-preferences')
  notifications(@CurrentUser() user: AuthUser, @Body() body: NotificationPrefsDto) {
    return this.me.setNotificationPrefs(user, body);
  }

  @AuthThrottle()
  @HttpCode(200)
  @Post('password/code')
  passwordCode(@CurrentUser() user: AuthUser, @Body() body: PasswordCodeDto) {
    return this.me.sendPasswordCode(user, body.channel);
  }

  @AuthThrottle()
  @HttpCode(200)
  @Post('password')
  changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto, @RequestMeta() meta: RequestMetaValue) {
    return this.me.changePassword(user, body, meta);
  }

  @AllowRestricted()
  @AuthThrottle()
  @HttpCode(200)
  @Post('close')
  close(@CurrentUser() user: AuthUser, @Body() body: CloseAccountDto) {
    return this.me.close(user, body);
  }
}
