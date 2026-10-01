import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every failure the API reports carries a stable machine code next to the
 * human sentence, so the apps can branch on `code` and toast `error`.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const Errors = {
  badRequest: (message: string, code = 'BAD_REQUEST', details?: unknown) =>
    new AppError(HttpStatus.BAD_REQUEST, code, message, details),
  unauthorized: (message = 'Sign in to continue.', code = 'UNAUTHORIZED') =>
    new AppError(HttpStatus.UNAUTHORIZED, code, message),
  forbidden: (message = 'You do not have access to this.', code = 'FORBIDDEN') =>
    new AppError(HttpStatus.FORBIDDEN, code, message),
  notFound: (message = 'We could not find that.', code = 'NOT_FOUND') =>
    new AppError(HttpStatus.NOT_FOUND, code, message),
  conflict: (message: string, code = 'CONFLICT', details?: unknown) =>
    new AppError(HttpStatus.CONFLICT, code, message, details),
  unprocessable: (message: string, code = 'UNPROCESSABLE', details?: unknown) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details),
  tooMany: (message: string, code = 'TOO_MANY_REQUESTS', details?: unknown) =>
    new AppError(HttpStatus.TOO_MANY_REQUESTS, code, message, details),
  badGateway: (message: string, code = 'PROVIDER_ERROR', details?: unknown) =>
    new AppError(HttpStatus.BAD_GATEWAY, code, message, details),
  unavailable: (message: string, code = 'UNAVAILABLE') =>
    new AppError(HttpStatus.SERVICE_UNAVAILABLE, code, message),
};
