import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class OAuthStartQueryDto {
  /** Same-site path to return to after signing in; anything else is dropped. */
  @IsOptional() @IsString() @MaxLength(500) next?: string;
}

export class OAuthExchangeDto {
  @IsString() @Length(20, 200) code: string;
}
