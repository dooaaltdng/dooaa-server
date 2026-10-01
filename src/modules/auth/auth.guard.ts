import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Errors } from '../../common/api/app-error';
import {
  ALLOW_RESTRICTED,
  AUTH_MODE,
  IS_PUBLIC,
  PERMISSIONS_KEY,
  REQUIRE_VERIFIED,
  USER_ROLES_KEY,
  type AuthMode,
} from '../../common/auth/decorators';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { Permission, UserRole } from '../../common/domain';
import { SettingsService } from '../settings/settings.service';
import { PrincipalService } from './principal.service';
import { TokenService } from './token.service';

type AuthedRequest = Request & { user?: AuthUser; staff?: AuthStaff };

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  return undefined;
}

/**
 * The one global guard. Routes are user-authenticated by default; `@Public`,
 * `@OptionalAuth` and `@StaffOnly` change that. Account status is checked on
 * every request, so a ban or suspension bites immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalService,
    private readonly settings: SettingsService,
  ) {}

  private meta<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(request);
    const mode = this.meta<AuthMode>(AUTH_MODE, context) ?? 'user';
    const isPublic = this.meta<boolean>(IS_PUBLIC, context) ?? false;

    if (mode === 'staff') {
      if (isPublic) return true;
      if (!token) throw Errors.unauthorized('Sign in to the console to continue.');
      request.staff = await this.authenticateStaff(token);
      await this.checkPermissions(request.staff, this.meta<Permission[]>(PERMISSIONS_KEY, context));
      return true;
    }

    if (isPublic || mode === 'optional') {
      if (token) {
        try {
          request.user = await this.authenticateUser(token, context);
        } catch (error) {
          // Guests are welcome here, but a token that is merely expired should
          // still tell the app to refresh rather than silently degrade.
          if (mode === 'optional' && (error as { code?: string }).code === 'TOKEN_EXPIRED') throw error;
        }
      }
      return true;
    }

    if (!token) throw Errors.unauthorized();
    const user = await this.authenticateUser(token, context);
    request.user = user;

    const roles = this.meta<UserRole[]>(USER_ROLES_KEY, context);
    if (roles?.length && (!user.role || !roles.includes(user.role))) {
      throw Errors.forbidden(
        roles.includes('seller') ? 'Switch to a seller account to use the seller tools.' : 'Your account cannot do this.',
        'ROLE_REQUIRED',
      );
    }
    if (this.meta<boolean>(REQUIRE_VERIFIED, context) && !user.emailVerified) {
      throw Errors.forbidden('Verify your email address first.', 'EMAIL_NOT_VERIFIED');
    }
    return true;
  }

  private async authenticateUser(token: string, context: ExecutionContext): Promise<AuthUser> {
    const payload = await this.tokens.verifyAccess('user', token);
    const user = await this.principals.user(payload.sub);
    if (!user) throw Errors.unauthorized('Your session has ended. Sign in again.', 'SESSION_REVOKED');
    // Status first: a banned account should hear that it is banned, not that its session ended.
    if (user.status === 'closed') throw Errors.unauthorized('This account has been closed.', 'ACCOUNT_CLOSED');
    if (user.status === 'banned') {
      throw Errors.forbidden('This account has been banned. Contact support if you think this is a mistake.', 'ACCOUNT_BANNED');
    }
    if (user.tokenVersion !== payload.ver) {
      throw Errors.unauthorized('Your session has ended. Sign in again.', 'SESSION_REVOKED');
    }
    if (user.status === 'suspended' && !this.meta<boolean>(ALLOW_RESTRICTED, context)) {
      throw Errors.forbidden('This account is suspended. Contact support to restore it.', 'ACCOUNT_SUSPENDED');
    }
    return user;
  }

  private async authenticateStaff(token: string): Promise<AuthStaff> {
    const payload = await this.tokens.verifyAccess('staff', token);
    const staff = await this.principals.staffMember(payload.sub);
    if (!staff || staff.tokenVersion !== payload.ver || staff.status !== 'active') {
      throw Errors.unauthorized('Your console session has ended. Sign in again.', 'SESSION_REVOKED');
    }
    return staff;
  }

  private async checkPermissions(staff: AuthStaff, required?: Permission[]): Promise<void> {
    if (!required?.length) return;
    const held = await this.settings.permissionsFor(staff.role);
    const missing = required.filter((permission) => !held.includes(permission));
    if (missing.length) {
      throw Errors.forbidden('Your role does not allow this action.', 'PERMISSION_DENIED');
    }
  }
}
