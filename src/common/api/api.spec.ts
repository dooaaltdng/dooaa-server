import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { ThrottlerException } from '@nestjs/throttler';
import { Errors } from './app-error';
import { toFailure } from './all-exceptions.filter';
import { flattenValidationErrors } from './validation';

describe('failure envelope', () => {
  it('passes AppErrors through with their code and details', () => {
    expect(toFailure(Errors.conflict('Taken.', 'EMAIL_TAKEN', { field: 'email' }))).toEqual({
      status: 409,
      body: { ok: false, error: 'Taken.', code: 'EMAIL_TAKEN', details: { field: 'email' } },
    });
  });

  it('maps framework exceptions to friendly copy', () => {
    expect(toFailure(new NotFoundException('Cannot GET /x'))).toEqual({ status: 404, body: { ok: false, error: 'We could not find that.', code: 'NOT_FOUND' } });
    expect(toFailure(new ThrottlerException()).body).toMatchObject({ code: 'TOO_MANY_REQUESTS', error: expect.stringMatching(/Too many requests/) });
    expect(toFailure(new BadRequestException('Bad thing')).body).toMatchObject({ code: 'BAD_REQUEST', error: 'Bad thing' });
  });

  it('turns unique violations into a 409 naming the field', () => {
    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505', constraint: 'users_email_key', table: 'users' });
    expect(toFailure(duplicate)).toEqual({
      status: 409,
      body: { ok: false, error: 'That email is already in use.', code: 'DUPLICATE', details: { field: 'email' } },
    });
    // Drizzle wraps the driver error; the cause is what counts.
    expect(toFailure(Object.assign(new Error('Failed query'), { cause: duplicate })).body).toMatchObject({ code: 'DUPLICATE', details: { field: 'email' } });
  });

  it('turns constraint and input errors into 4xx answers', () => {
    expect(toFailure({ code: '23514', constraint: 'products_price_nonnegative' })).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
    expect(toFailure({ code: '23503', constraint: 'orders_buyer_id_users_id_fk' })).toMatchObject({ status: 409, body: { code: 'REFERENCE_MISSING' } });
    expect(toFailure({ code: '22P02' }).body).toEqual({ ok: false, error: 'Invalid value.', code: 'INVALID_ID' });
    expect(toFailure({ name: 'MulterError', code: 'LIMIT_FILE_SIZE' })).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('hides unexpected errors behind a generic 500', () => {
    expect(toFailure(new Error('secret stack detail'))).toEqual({
      status: 500,
      body: { ok: false, error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' },
    });
  });
});

describe('validation details', () => {
  it('flattens nested errors into dotted paths', () => {
    const child = Object.assign(new ValidationError(), { property: 'city', constraints: { isNotEmpty: 'Enter your city.' }, children: [] });
    const parent = Object.assign(new ValidationError(), { property: 'delivery', children: [child] });
    const top = Object.assign(new ValidationError(), { property: 'email', constraints: { isEmail: 'Enter a valid email address.' }, children: [] });
    expect(flattenValidationErrors([top, parent])).toEqual([
      { field: 'email', messages: ['Enter a valid email address.'] },
      { field: 'delivery.city', messages: ['Enter your city.'] },
    ]);
  });
});
