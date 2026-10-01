import { ValidationError, ValidationPipe } from '@nestjs/common';
import { Errors } from './app-error';

export type FieldError = { field: string; messages: string[] };

/** Flattens nested class-validator errors into `field.path → messages`. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) out.push({ field, messages: Object.values(error.constraints) });
    if (error.children?.length) out.push(...flattenValidationErrors(error.children, field));
  }
  return out;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => {
      const details = flattenValidationErrors(errors);
      const first = details[0]?.messages[0] ?? 'Validation failed.';
      return Errors.badRequest(first, 'VALIDATION_FAILED', details);
    },
  });
}
