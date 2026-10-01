import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from './app-error';
import type { ApiFailure } from './envelope';

const STATUS_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL',
  502: 'PROVIDER_ERROR',
  503: 'UNAVAILABLE',
};

const FRIENDLY: Record<number, string> = {
  404: 'We could not find that.',
  413: 'That file is too large.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Something went wrong on our side. Please try again.',
};

type Failure = { status: number; body: ApiFailure };

function messageOf(response: unknown, fallback: string): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const value = (response as { message?: unknown }).message;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return fallback;
}

/** Translates anything thrown into the `{ ok: false, error, code }` envelope. */
export function toFailure(exception: unknown): Failure {
  if (exception instanceof AppError) {
    const status = exception.getStatus();
    const response = exception.getResponse() as { message: string; details?: unknown };
    return {
      status,
      body: {
        ok: false,
        error: response.message,
        code: exception.code,
        ...(response.details !== undefined ? { details: response.details } : {}),
      },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const fallback = FRIENDLY[status] ?? exception.message;
    const message = status === 404 ? FRIENDLY[404] : status === 429 ? FRIENDLY[429] : messageOf(exception.getResponse(), fallback);
    return { status, body: { ok: false, error: message, code: STATUS_CODE[status] ?? 'ERROR' } };
  }

  const error = exception as { name?: string; code?: number | string; keyValue?: Record<string, unknown>; path?: string; errors?: Record<string, { message: string }> };

  if (error?.code === 11000) {
    const field = Object.keys(error.keyValue ?? {})[0];
    return {
      status: HttpStatus.CONFLICT,
      body: {
        ok: false,
        error: field ? `That ${field} is already in use.` : 'That record already exists.',
        code: 'DUPLICATE',
        ...(field ? { details: { field } } : {}),
      },
    };
  }

  if (error?.name === 'CastError') {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: { ok: false, error: `Invalid ${error.path ?? 'value'}.`, code: 'INVALID_ID' },
    };
  }

  if (error?.name === 'ValidationError' && error.errors) {
    const details = Object.entries(error.errors).map(([field, value]) => ({ field, messages: [value.message] }));
    return {
      status: HttpStatus.BAD_REQUEST,
      body: { ok: false, error: details[0]?.messages[0] ?? 'Validation failed.', code: 'VALIDATION_FAILED', details },
    };
  }

  if (error?.name === 'MulterError') {
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return {
      status: tooLarge ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST,
      body: {
        ok: false,
        error: tooLarge ? FRIENDLY[413] : 'That upload could not be read.',
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'BAD_UPLOAD',
      },
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { ok: false, error: FRIENDLY[500], code: 'INTERNAL' },
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = toFailure(exception);
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }
    if (response.headersSent) return;
    response.status(status).json(body);
  }
}
