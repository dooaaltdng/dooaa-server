import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';
import { Trim } from '../../../common/util/transforms';

export class ResolveAccountDto {
  @Trim() @Matches(/^\d{3,6}$/, { message: 'Choose a bank from the list.' }) bankCode: string;
  @Trim() @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number.' }) accountNumber: string;
}

export class AddPaymentAccountDto {
  /** Bank accounts are added here; cards are never stored (buyers enter them on Bachs' checkout). */
  @IsIn(['bank', 'card']) type: 'bank' | 'card';
  @IsOptional() @Trim() @Matches(/^\d{3,6}$/, { message: 'Choose a bank from the list.' }) bankCode?: string;
  @IsOptional() @Trim() @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number.' }) accountNumber?: string;
  @IsOptional() @IsBoolean() primary?: boolean;
}
