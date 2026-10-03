import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppError } from '../../../common/api/app-error';
import { Public, RequestMeta, type RequestMetaValue } from '../../../common/auth/decorators';
import { AuthThrottle } from '../../../common/auth/throttle';
import { InjectConfig } from '../../../config/config.module';
import type { AppConfig } from '../../../config/configuration';
import { REFRESH_COOKIE } from '../auth.controller';
import { OAuthExchangeDto, OAuthStartQueryDto } from './oauth.dto';
import { OAuthService } from './oauth.service';

export const OAUTH_NONCE_COOKIE = 'dooaa_oauth';
const COOKIE_PATH = '/api/v1/auth/oauth';

/**
 * Social sign-in. `start` and `callback` are browser navigations and answer
 * with redirects; every failure lands on the client's sign-in page with an
 * `error` code instead of a JSON body.
 */
@ApiTags('Auth')
@Controller('auth/oauth')
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('providers')
  providers() {
    return this.oauth.list();
  }

  @Public()
  @AuthThrottle()
  @Get(':provider/start')
  async start(@Param('provider') provider: string, @Query() query: OAuthStartQueryDto, @Res() response: Response) {
    try {
      const { url, nonce } = await this.oauth.start(provider, query.next);
      // Lax, not the refresh cookie's setting: it must ride along on the provider's top-level redirect back.
      response.cookie(OAUTH_NONCE_COOKIE, nonce, {
        httpOnly: true,
        secure: this.config.auth.cookieSecure,
        sameSite: 'lax',
        path: COOKIE_PATH,
        maxAge: 10 * 60 * 1000,
      });
      response.redirect(302, url);
    } catch (error) {
      response.redirect(302, this.oauth.clientRedirect({ error: this.codeOf(error) }));
    }
  }

  @Public()
  @AuthThrottle()
  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Req() request: Request, @Res() response: Response) {
    // Read raw: providers append parameters of their own (iss, scope, authuser…), which strict DTO validation would reject.
    const param = (name: string) => {
      const value = request.query[name];
      return typeof value === 'string' && value.length <= 4000 ? value : undefined;
    };
    const query = { code: param('code'), state: param('state'), error: param('error') };
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    response.clearCookie(OAUTH_NONCE_COOKIE, { path: COOKIE_PATH });
    try {
      response.redirect(302, await this.oauth.callback(provider, query, cookies?.[OAUTH_NONCE_COOKIE]));
    } catch (error) {
      response.redirect(302, this.oauth.clientRedirect({ error: this.codeOf(error) }));
    }
  }

  @Public()
  @AuthThrottle()
  @HttpCode(200)
  @Post('exchange')
  async exchange(@Body() body: OAuthExchangeDto, @RequestMeta() meta: RequestMetaValue, @Res({ passthrough: true }) response: Response) {
    const result = await this.oauth.exchange(body.code, meta);
    response.cookie(REFRESH_COOKIE, result.tokens.refreshToken, {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: this.config.auth.cookieSameSite,
      path: '/api/v1/auth',
      expires: new Date(result.tokens.refreshExpiresAt),
    });
    return result;
  }

  private codeOf(error: unknown): string {
    return error instanceof AppError ? error.code : 'OAUTH_FAILED';
  }
}
