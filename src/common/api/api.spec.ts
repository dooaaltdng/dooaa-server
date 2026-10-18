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
    const duplicate = Object.assign(new Error('E11000 duplicate key error collection: dooaa.users index: users_email_key dup key: { email: "a@b.c" }'), { code: 11000 });
    expect(toFailure(duplicate)).toEqual({
      status: 409,
      body: { ok: false, error: 'That email is already in use.', code: 'DUPLICATE', details: { field: 'email' } },
    });
  });

  it('turns upload errors into 4xx answers', () => {
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
