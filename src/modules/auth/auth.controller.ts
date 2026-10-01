import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import {
  AllowRestricted,
  CurrentUser,
  Public,
  RequestMeta,
  type RequestMetaValue,
} from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/principal';
import { AuthThrottle } from '../../common/auth/throttle';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  RefreshDto,
  ResetPasswordDto,
  SendOtpDto,
  SetRoleDto,
  SignInDto,
  SignUpDto,
  VerifyOtpDto,
  VerifyPasswordDto,
} from './dto/auth.dto';
import type { TokenPair } from './token.service';

export const REFRESH_COOKIE = 'dooaa_rt';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private cookieOptions(expires?: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: this.config.auth.cookieSameSite,
      path: '/api/v1/auth',
      ...(expires ? { expires } : {}),
    };
  }

  private setRefreshCookie(response: Response, tokens: TokenPair): void {
    response.cookie(REFRESH_COOKIE, tokens.refreshToken, this.cookieOptions(new Date(tokens.refreshExpiresAt)));
  }

  private refreshTokenFrom(request: Request, body?: RefreshDto): string | undefined {
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    return body?.refreshToken || cookies?.[REFRESH_COOKIE];
  }

  @Public()
  @AuthThrottle()
  @Post('sign-up')
  async signUp(@Body() body: SignUpDto, @RequestMeta() meta: RequestMetaValue, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.signUp(body, meta);
    this.setRefreshCookie(response, result.tokens);
    return result;
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('sign-in')
  async signIn(@Body() body: SignInDto, @RequestMeta() meta: RequestMetaValue, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.signIn(body, meta);
    this.setRefreshCookie(response, result.tokens);
    return result;
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Body() body: RefreshDto,
    @Req() request: Request,
    @RequestMeta() meta: RequestMetaValue,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.refresh(this.refreshTokenFrom(request, body), meta);
    this.setRefreshCookie(response, result.tokens);
    return result;
  }

  @Public()
  @HttpCode(200)
  @Post('sign-out')
  async signOut(@Body() body: RefreshDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.signOut(this.refreshTokenFrom(request, body));
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { signedOut: true };
  }

  @ApiBearerAuth('user')
  @AllowRestricted()
  @HttpCode(200)
  @Post('sign-out-all')
  async signOutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) response: Response) {
    await this.auth.signOutEverywhere(user);
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return { signedOut: true };
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('otp/send')
  sendOtp(@Body() body: SendOtpDto) {
    return this.auth.sendOtp(body);
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('otp/verify')
  verifyOtp(@Body() body: VerifyOtpDto) {
    return this.auth.verifyOtp(body);
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('password/forgot')
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.auth.sendOtp({ ...body, purpose: 'reset-password' });
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('password/reset')
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.auth.resetPassword(body.resetToken, body.password);
  }

  @ApiBearerAuth('user')
  @AuthThrottle()
  @HttpCode(200)
  @Post('password/verify')
  verifyPassword(@CurrentUser() user: AuthUser, @Body() body: VerifyPasswordDto) {
    return this.auth.verifyPassword(user, body.password);
  }

  @ApiBearerAuth('user')
  @Patch('role')
  setRole(@CurrentUser() user: AuthUser, @Body() body: SetRoleDto) {
    return this.auth.setRole(user, body.role);
  }

  @ApiBearerAuth('user')
  @AllowRestricted()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
