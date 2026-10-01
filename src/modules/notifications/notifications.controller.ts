import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ObjectIdPipe } from '../../common/api/object-id.pipe';
import { AllowRestricted, CurrentStaff, CurrentUser, StaffOnly } from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { PageQueryDto } from '../../common/util/pagination';
import { ToBoolean } from '../../common/util/transforms';
import { NotificationsService } from './notifications.service';

class NotificationsQueryDto extends PageQueryDto {
  @IsOptional() @ToBoolean() @IsBoolean() unread?: boolean;
}

@ApiTags('Notifications')
@AllowRestricted()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: NotificationsQueryDto) {
    return this.notifications.list({ id: user.id, type: 'user' }, query);
  }

  @Get('unread-count')
  async unread(@CurrentUser() user: AuthUser) {
    return { unread: await this.notifications.unreadCount({ id: user.id, type: 'user' }) };
  }

  @HttpCode(200)
  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead({ id: user.id, type: 'user' });
  }

  @HttpCode(200)
  @Post(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id', ObjectIdPipe) id: string) {
    return this.notifications.markRead({ id: user.id, type: 'user' }, id);
  }
}

/** The console's bell. */
@ApiTags('Admin · Notifications')
@StaffOnly()
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentStaff() staff: AuthStaff, @Query() query: NotificationsQueryDto) {
    return this.notifications.list({ id: staff.id, type: 'staff' }, query);
  }

  @HttpCode(200)
  @Post('read-all')
  readAll(@CurrentStaff() staff: AuthStaff) {
    return this.notifications.markAllRead({ id: staff.id, type: 'staff' });
  }

  @HttpCode(200)
  @Post(':id/read')
  read(@CurrentStaff() staff: AuthStaff, @Param('id', ObjectIdPipe) id: string) {
    return this.notifications.markRead({ id: staff.id, type: 'staff' }, id);
  }
}
