import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const MIN_PASSWORD_LENGTH = 8;

/** "Password must be 8+ characters including letters, numbers & symbols." */
export const IsStrongPassword = () =>
  applyDecorators(
    IsString(),
    MinLength(MIN_PASSWORD_LENGTH, { message: `Password must be ${MIN_PASSWORD_LENGTH}+ characters.` }),
    MaxLength(128, { message: 'Password is too long.' }),
    Matches(/[a-zA-Z]/, { message: 'Include letters, numbers & symbols.' }),
    Matches(/\d/, { message: 'Include letters, numbers & symbols.' }),
    Matches(/[^a-zA-Z0-9]/, { message: 'Include letters, numbers & symbols.' }),
  );

/** At least ten digits once spaces and symbols are stripped. */
export const IsPhoneNumber = () =>
  applyDecorators(
    IsString(),
    MaxLength(24),
    Matches(/^(?:\D*\d){10,15}\D*$/, { message: 'Enter a valid phone number.' }),
  );

export const IsPersonName = (label: string) =>
  applyDecorators(
    IsString(),
    MinLength(2, { message: `${label} must be at least 2 characters.` }),
    MaxLength(60, { message: `${label} is too long.` }),
  );
