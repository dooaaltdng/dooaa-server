import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Trim, ToLowerTrim } from '../../../common/util/transforms';
import { IsPhoneNumber } from '../../../common/util/validators';

export class AddCartItemDto {
  @IsMongoId({ message: 'Choose a product.' }) productId: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(999) quantity?: number;
}

export class SetQuantityDto {
  @Type(() => Number) @IsInt({ message: 'Quantity must be a whole number.' }) @Min(1, { message: 'Quantity must be at least 1.' }) @Max(999) quantity: number;
}

export class CouponDto {
  @Trim() @IsString() @MinLength(2, { message: 'Enter a coupon code.' }) @MaxLength(24) code: string;
}

export class DeliveryInfoDto {
  @Trim() @IsString() @MinLength(2, { message: 'Enter your first name.' }) @MaxLength(60) firstName: string;
  @Trim() @IsString() @MinLength(2, { message: 'Enter your last name.' }) @MaxLength(60) lastName: string;
  @Trim() @IsString() @MinLength(5, { message: 'Enter your address.' }) @MaxLength(200) address: string;
  @Trim() @IsString() @MinLength(2, { message: 'Enter your city/town.' }) @MaxLength(80) city: string;
  @IsOptional() @Trim() @IsString() @MaxLength(80) state?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(20) zip?: string;
  @Trim() @IsPhoneNumber() phone: string;
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) email: string;
}

export class MergeCartDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AddCartItemDto) items: AddCartItemDto[];
}
