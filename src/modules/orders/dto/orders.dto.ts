import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { CARRIERS, CHECKOUT_METHODS, ORDER_STATUSES, type CheckoutMethod, type OrderStatus } from '../../../common/domain';
import { PageQueryDto } from '../../../common/util/pagination';
import { ToLowerTrim, Trim } from '../../../common/util/transforms';
import { IsPhoneNumber } from '../../../common/util/validators';
import { DeliveryInfoDto } from '../../cart/dto/cart.dto';
import { OTP_CHANNELS, type OtpChannel } from '../../otp/otp.schema';

const METHOD_MESSAGE = 'Choose card, bank transfer, USSD or bank. PayPal is not available.';

export class CheckoutDto {
  @IsIn(CHECKOUT_METHODS, { message: METHOD_MESSAGE }) method: CheckoutMethod;
  /** Pay with a card saved from an earlier purchase. */
  @IsOptional() @IsMongoId() savedCardId?: string;
  /** Overrides the delivery details saved on the cart. */
  @IsOptional() @ValidateNested() @Type(() => DeliveryInfoDto) delivery?: DeliveryInfoDto;
}

/** "Delivery Information" on Confirm Your Purchase. */
export class EscrowDeliveryDto {
  @Trim() @IsString() @MinLength(2, { message: 'Enter your first name.' }) @MaxLength(60) firstName: string;
  @Trim() @IsString() @MinLength(2, { message: 'Enter your last name.' }) @MaxLength(60) lastName: string;
  @Trim() @IsString() @MinLength(5, { message: 'Enter your address.' }) @MaxLength(200) address: string;
  @Trim() @IsString() @MinLength(2, { message: 'Enter your city/town.' }) @MaxLength(80) city: string;
  @IsOptional() @Trim() @IsString() @MaxLength(80) state?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(20) zip?: string;
  @Trim() @IsPhoneNumber() phone: string;
  @ToLowerTrim() @IsEmail({}, { message: 'Enter a valid email address.' }) email: string;
}

export class EscrowCheckoutDto {
  @IsMongoId({ message: 'Choose a product.' }) productId: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(99) quantity?: number;
  @IsIn(CHECKOUT_METHODS, { message: METHOD_MESSAGE }) method: CheckoutMethod;
  @IsOptional() @IsMongoId() savedCardId?: string;
  /** An accepted offer from chat: its agreed price is charged instead of the listed one. */
  @IsOptional() @IsMongoId() offerId?: string;
  @ValidateNested() @Type(() => EscrowDeliveryDto) delivery: EscrowDeliveryDto;
}

export class EscrowQuoteQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(99) quantity?: number;
  @IsOptional() @IsMongoId() offerId?: string;
}

/** "All Orders", "Pending"… as the status filter writes them, or the canonical values. */
const ToStatus = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
    return normalized === 'all-orders' || normalized === 'all' || normalized === '' ? undefined : normalized;
  });

export class OrdersQueryDto extends PageQueryDto {
  @IsOptional() @ToStatus() @IsIn(ORDER_STATUSES) status?: OrderStatus;
  @IsOptional() @Trim() @IsString() @MaxLength(80) q?: string;
}

export class ReasonDto {
  @Trim() @IsString() @MinLength(3, { message: 'Tell us why.' }) @MaxLength(500) reason: string;
}

export class ShipOrderDto {
  @Trim() @IsString() @MinLength(2, { message: 'Select a carrier.' }) @MaxLength(60) carrier: string;
  @Trim() @IsString() @MinLength(3, { message: 'Enter the tracking number.' }) @MaxLength(60) trackingNumber: string;
  @IsOptional() @IsUrl({ require_tld: false, require_protocol: true }) proofUrl?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(300) note?: string;
}

export class DeliverOrderDto {
  @IsOptional() @IsUrl({ require_tld: false, require_protocol: true }) proofUrl?: string;
  @IsOptional() @Trim() @IsString() @MaxLength(300) note?: string;
}

export class ReleaseCodeDto {
  @IsOptional() @IsIn(OTP_CHANNELS) channel?: OtpChannel;
}

export class ReleaseDto {
  @Trim() @IsString() @MinLength(6, { message: 'Enter all 6 digits.' }) @MaxLength(6, { message: 'Enter all 6 digits.' }) code: string;
}

export const KNOWN_CARRIERS = CARRIERS;
