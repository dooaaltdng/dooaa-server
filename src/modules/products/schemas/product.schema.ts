import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import {
  CONDITIONS,
  DELIVERY_TYPES,
  LISTED_AS,
  LISTING_PAYMENT_METHODS,
  LISTING_STATUSES,
  PRICING_TYPES,
  type Condition,
  type DeliveryType,
  type ListedAs,
  type ListingPaymentMethod,
  type ListingStatus,
  type PricingType,
} from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

@Schema({ _id: false })
export class ProductVideo {
  @Prop({ required: true }) url: string;
  @Prop() posterUrl?: string;
}
const ProductVideoSchema = SchemaFactory.createForClass(ProductVideo);

@Schema({ _id: false })
export class ProductModeration {
  /** Why the listing was queued or flagged: unverified-seller, review-category, high-value, price-outlier, seller-restricted… */
  @Prop({ type: [String], default: [] }) flags: string[];
  @Prop() note?: string;
  @Prop() reviewedBy?: string;
  @Prop() reviewedAt?: Date;
}
const ProductModerationSchema = SchemaFactory.createForClass(ProductModeration);

@Schema({ _id: false })
export class ProductStats {
  @Prop({ default: 0 }) views: number;
  /** Conversations started about the listing — the console's "inquiries". */
  @Prop({ default: 0 }) inquiries: number;
  @Prop({ default: 0 }) wishlists: number;
  @Prop({ default: 0 }) unitsSold: number;
  @Prop({ default: 0 }) revenue: number;
  @Prop() lastSaleAt?: Date;
  @Prop({ default: 0 }) ratingAverage: number;
  @Prop({ default: 0 }) ratingCount: number;
}
const ProductStatsSchema = SchemaFactory.createForClass(ProductStats);

/**
 * A listing. One model backs the storefront's product cards and detail page,
 * the seller's Products tab and the console's Items & Listing table.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'products' })
export class Product {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ required: true, trim: true, maxlength: 140 }) title: string;
  @Prop({ trim: true, default: '' }) description: string;
  /** The one-line summary on cards, derived from the description. */
  @Prop({ trim: true, default: '' }) summary: string;
  /** "Additional Description" bullets / the spec list. */
  @Prop({ type: [String], default: [] }) highlights: string[];
  @Prop({ required: true }) categoryId: string;
  @Prop({ trim: true }) brand?: string;
  @Prop({ type: String, enum: CONDITIONS, required: true }) condition: Condition;
  @Prop({ required: true, min: 0 }) price: number;
  @Prop() previousPrice?: number;
  @Prop() priceChangedAt?: Date;
  @Prop() previousPriceSince?: Date;
  @Prop({ type: String, enum: PRICING_TYPES, default: 'fixed' }) pricing: PricingType;
  @Prop({ type: String, enum: LISTING_PAYMENT_METHODS, default: 'escrow' }) paymentMethod: ListingPaymentMethod;
  @Prop({ type: String, enum: DELIVERY_TYPES, default: 'nationwide' }) delivery: DeliveryType;
  @Prop({ required: true, min: 0, default: 0 }) stock: number;
  @Prop({ trim: true, default: 'Lagos' }) location: string;
  @Prop({ type: [String], default: [] }) images: string[];
  @Prop({ type: [ProductVideoSchema], default: [] }) videos: ProductVideo[];
  @Prop({ type: String, enum: LISTING_STATUSES, default: 'draft' }) status: ListingStatus;
  @Prop({ type: ProductModerationSchema, default: () => ({}) }) moderation: ProductModeration;
  @Prop({ type: String, enum: LISTED_AS, default: 'seller' }) listedAs: ListedAs;
  /** Curated onto the "Featured" rail by the console. */
  @Prop({ default: false }) featured: boolean;
  /** Mirrors the seller's identity check, for the "Verified sellers" facet. */
  @Prop({ default: false }) sellerVerified: boolean;
  @Prop({ type: ProductStatsSchema, default: () => ({}) }) stats: ProductStats;
  @Prop() publishedAt?: Date;
  @Prop() deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductDocument = HydratedDocument<Product>;
export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ status: 1, deletedAt: 1, categoryId: 1, createdAt: -1 });
ProductSchema.index({ status: 1, deletedAt: 1, price: 1 });
ProductSchema.index({ status: 1, deletedAt: 1, 'stats.unitsSold': -1 });
ProductSchema.index({ status: 1, deletedAt: 1, 'stats.views': -1 });
ProductSchema.index({ status: 1, deletedAt: 1, featured: 1, createdAt: -1 });
ProductSchema.index({ sellerId: 1, deletedAt: 1, createdAt: -1 });
ProductSchema.index(
  { title: 'text', brand: 'text', summary: 'text', location: 'text', description: 'text' },
  { weights: { title: 10, brand: 6, summary: 3, location: 2, description: 1 }, name: 'product_text', default_language: 'english' },
);
