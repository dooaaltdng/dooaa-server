import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentStaff, Public, RequestMeta, StaffOnly, type RequestMetaValue } from '../../common/auth/decorators';
import type { AuthStaff } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { AcceptInviteDto, ChangeStaffPasswordDto, StaffRefreshDto, StaffSignInDto } from './dto/staff.dto';
import { StaffService } from './staff.service';

export const STAFF_REFRESH_COOKIE = 'dooaa_admin_rt';

@ApiTags('Admin · Auth')
@StaffOnly()
@Controller('admin/auth')
export class StaffAuthController {
  constructor(
    private readonly staff: StaffService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private cookieOptions(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: this.config.auth.cookieSameSite,
      path: '/api/v1/admin/auth',
      ...(expires ? { expires } : {}),
    };
  }

  private tokenFrom(request: Request, body?: StaffRefreshDto): string | undefined {
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    return body?.refreshToken || cookies?.[STAFF_REFRESH_COOKIE];
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('sign-in')
  async signIn(@Body() body: StaffSignInDto, @RequestMeta() meta: RequestMetaValue, @Res({ passthrough: true }) response: Response) {
    const result = await this.staff.signIn(body.email, body.password, meta);
    response.cookie(STAFF_REFRESH_COOKIE, result.tokens.refreshToken, this.cookieOptions(new Date(result.tokens.refreshExpiresAt)));
    return result;
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Body() body: StaffRefreshDto, @Req() request: Request, @RequestMeta() meta: RequestMetaValue, @Res({ passthrough: true }) response: Response) {
    const result = await this.staff.refresh(this.tokenFrom(request, body), meta);
    response.cookie(STAFF_REFRESH_COOKIE, result.tokens.refreshToken, this.cookieOptions(new Date(result.tokens.refreshExpiresAt)));
    return result;
  }

  @Public()
  @HttpCode(200)
  @Post('sign-out')
  async signOut(@Body() body: StaffRefreshDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.staff.signOut(this.tokenFrom(request, body));
    response.clearCookie(STAFF_REFRESH_COOKIE, this.cookieOptions());
    return { signedOut: true };
  }

  @Get('me')
  me(@CurrentStaff() actor: AuthStaff) {
    return this.staff.me(actor);
  }

  /** Your own password. Every other session ends; this one gets fresh tokens. */
  @AuthThrottle()
  @HttpCode(200)
  @Post('password')
  async changePassword(
    @CurrentStaff() actor: AuthStaff,
    @Body() body: ChangeStaffPasswordDto,
    @RequestMeta() meta: RequestMetaValue,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.staff.changePassword(actor, body.currentPassword, body.newPassword, meta);
    response.cookie(STAFF_REFRESH_COOKIE, result.tokens.refreshToken, this.cookieOptions(new Date(result.tokens.refreshExpiresAt)));
    return result;
  }

  @Public()
  @Get('invite/:token')
  inviteInfo(@Param('token') token: string) {
    return this.staff.inviteInfo(token);
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('accept-invite')
  async acceptInvite(@Body() body: AcceptInviteDto, @RequestMeta() meta: RequestMetaValue, @Res({ passthrough: true }) response: Response) {
    const result = await this.staff.acceptInvite(body.token, body.password, meta);
    response.cookie(STAFF_REFRESH_COOKIE, result.tokens.refreshToken, this.cookieOptions(new Date(result.tokens.refreshExpiresAt)));
    return result;
  }
}
