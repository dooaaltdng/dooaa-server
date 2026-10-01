import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { Trim } from '../../../common/util/transforms';

export class ResolveAccountDto {
  @Trim() @Matches(/^\d{3,6}$/, { message: 'Choose a bank from the list.' }) bankCode: string;
  @Trim() @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number.' }) accountNumber: string;
}

export class AddPaymentAccountDto {
  /** Bank accounts are added here; cards are saved when you pay with them on the provider's checkout. */
  @IsIn(['bank', 'card']) type: 'bank' | 'card';
  @IsOptional() @Trim() @Matches(/^\d{3,6}$/, { message: 'Choose a bank from the list.' }) bankCode?: string;
  @IsOptional() @Trim() @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number.' }) accountNumber?: string;
  @IsOptional() @IsBoolean() primary?: boolean;
}

export class SandboxPayDto {
  @IsIn(['success', 'failed']) outcome: 'success' | 'failed';
  @IsOptional() @IsIn(['card', 'bank_transfer', 'ussd']) channel?: 'card' | 'bank_transfer' | 'ussd';
}

export class SandboxFormDto {
  @IsIn(['success', 'failed', 'cancel']) outcome: 'success' | 'failed' | 'cancel';
  @IsOptional() @IsString() channel?: string;
}
