import { SetMetadata } from '@nestjs/common';

export const AUTH_THROTTLE = 'throttle:auth';

/**
 * Puts a route under the stricter "auth" rate limit (credential and code
 * endpoints), on top of the default limit every route has.
 */
export const AuthThrottle = () => SetMetadata(AUTH_THROTTLE, true);
