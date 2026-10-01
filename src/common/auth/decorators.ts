import { ExecutionContext, SetMetadata, applyDecorators, createParamDecorator } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Permission, UserRole } from '../domain';
import type { AuthStaff, AuthUser } from './principal';

export const IS_PUBLIC = 'auth:public';
export const AUTH_MODE = 'auth:mode';
export const USER_ROLES_KEY = 'auth:roles';
export const PERMISSIONS_KEY = 'auth:permissions';
export const REQUIRE_VERIFIED = 'auth:verified';
export const ALLOW_RESTRICTED = 'auth:allow-restricted';

export type AuthMode = 'user' | 'staff' | 'optional';

/** No token needed. A valid user token, if sent, is still attached. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Works signed in or out; `@CurrentUser()` is undefined for guests. */
export const OptionalAuth = () => SetMetadata(AUTH_MODE, 'optional' satisfies AuthMode);

/** Console routes: a staff token is required and user tokens are refused. */
export const StaffOnly = () => applyDecorators(SetMetadata(AUTH_MODE, 'staff' satisfies AuthMode), ApiBearerAuth('staff'));

/** Marketplace routes limited to a role, e.g. the seller tools. */
export const Roles = (...roles: UserRole[]) => SetMetadata(USER_ROLES_KEY, roles);
export const SellerOnly = () => Roles('seller');

/** Console verbs gated by the role/permission matrix in Settings. */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** The account must have confirmed its email before it can do this. */
export const RequireVerifiedEmail = () => SetMetadata(REQUIRE_VERIFIED, true);

/** Reachable by suspended accounts too (profile, sign out, contacting support). */
export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED, true);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser | undefined => {
  return context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
});

export const CurrentStaff = createParamDecorator((_data: unknown, context: ExecutionContext): AuthStaff | undefined => {
  return context.switchToHttp().getRequest<{ staff?: AuthStaff }>().staff;
});

/** Client IP and user agent, for sessions and audit. */
export const RequestMeta = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ ip?: string; headers: Record<string, string | undefined> }>();
  return { ip: request.ip, userAgent: request.headers['user-agent']?.slice(0, 300) };
});

export type RequestMetaValue = { ip?: string; userAgent?: string };
