import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  COLLECTIONS,
  CONDITIONS,
  DELIVERY_TYPES,
  LISTING_PAYMENT_METHODS,
  PRICE_BANDS,
  PRICING_TYPES,
  SORT_KEYS,
  type Collection,
  type Condition,
  type DeliveryType,
  type ListingPaymentMethod,
  type PriceBand,
  type PricingType,
  type SortKey,
} from '../../../common/domain';
import { PageQueryDto } from '../../../common/util/pagination';
import { ToArray, ToBoolean, Trim } from '../../../common/util/transforms';
import { normalizeCondition } from '../product.filters';

const URL_OPTIONS = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

/** The storefront filters, exactly the query string the catalog pages write. */
export class CatalogQueryDto {
  @IsOptional() @Trim() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @ToArray() @IsArray() @ArrayMaxSize(12) @IsString({ each: true }) category?: string[];
  @IsOptional() @IsIn(SORT_KEYS) sort?: SortKey;
  @IsOptional() @IsIn(Object.keys(PRICE_BANDS)) price?: PriceBand;
  @IsOptional() @ToArray() @IsArray() @ArrayMaxSize(6) @IsString({ each: true }) condition?: string[];
  @IsOptional() @ToArray() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) brand?: string[];
  @IsOptional() @ToArray() @IsArray() @ArrayMaxSize(2) @IsString({ each: true }) seller?: string[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) min?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) max?: number;
  @IsOptional() @IsIn(COLLECTIONS) collection?: Collection;
  @IsOptional() @ToBoolean() @IsBoolean() inStock?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) limit?: number;
}

export class SuggestQueryDto {
  @Trim() @IsString() @MinLength(1) @MaxLength(60) q: string;
}

/** Accepts the form labels ("Brand New", "Slightly Used") as well as the canonical values. */
const ToCondition = () => Transform(({ value }) => (typeof value === 'string' ? (normalizeCondition(value) ?? value) : value));

/** "Additional Description" arrives either as bullet lines or as one block of text. */
const ToLines = () =>
  Transform(({ value }) => {
    if (typeof value === 'string') return value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (Array.isArray(value)) return value.map((line) => (typeof line === 'string' ? line.trim() : line)).filter(Boolean);
    return value;
  });

export class ProductInputDto {
  @Trim() @IsString() @MinLength(3, { message: 'Give the product a name.' }) @MaxLength(140) title: string;
  @Trim() @IsString() @MinLength(10, { message: 'Describe the product in a sentence or two.' }) @MaxLength(5000) description: string;
  @IsOptional() @ToLines() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(200, { each: true }) highlights?: string[];
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Enter a valid price.' }) @Min(1, { message: 'Enter a valid price.' }) @Max(10_000_000_000) price: number;
  @IsIn(PRICING_TYPES) pricing: PricingType;
  @ToCondition() @IsIn(CONDITIONS, { message: 'Choose the condition.' }) condition: Condition;
  @Type(() => Number) @IsInt({ message: 'Stock must be a whole number.' }) @Min(0) @Max(1_000_000) stock: number;
  @Trim() @IsString() @MinLength(2, { message: 'Choose a category.' }) categoryId: string;
  @IsOptional() @Trim() @IsString() @MaxLength(60) brand?: string;
  @IsIn(DELIVERY_TYPES) delivery: DeliveryType;
  @IsIn(LISTING_PAYMENT_METHODS) paymentMethod: ListingPaymentMethod;
  @IsOptional() @Trim() @IsString() @MaxLength(80) location?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8, { message: 'Add up to eight photos.' }) @IsUrl(URL_OPTIONS, { each: true }) images?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(4, { message: 'Add up to four videos.' }) @IsUrl(URL_OPTIONS, { each: true }) videos?: string[];
}

export class CreateProductDto extends ProductInputDto {
  /** False saves a draft; true submits for publishing (moderation decides whether it goes live). */
  @IsOptional() @IsBoolean() publish?: boolean;
}

export class UpdateProductDto extends PartialType(ProductInputDto) {}

export class SellerProductStatusDto {
  @IsIn(['active', 'draft', 'inactive'], { message: 'Choose active, draft or inactive.' }) status: 'active' | 'draft' | 'inactive';
}

export const SELLER_STATUS_FILTERS = ['active', 'draft', 'out-of-stock', 'pending', 'inactive', 'rejected'] as const;
export type SellerStatusFilter = (typeof SELLER_STATUS_FILTERS)[number];

export class SellerProductsQueryDto extends PageQueryDto {
  @IsOptional() @IsIn(['all', 'active', 'inactive', 'draft']) tab?: 'all' | 'active' | 'inactive' | 'draft';
  @IsOptional() @Trim() @IsString() @MaxLength(80) q?: string;
  /** The "All Status" dropdown: the status pill a listing shows. */
  @IsOptional() @IsIn(SELLER_STATUS_FILTERS) status?: SellerStatusFilter;
}
