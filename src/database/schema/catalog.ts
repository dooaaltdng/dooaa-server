import type { Condition, CouponType, DeliveryType, ListedAs, ListingPaymentMethod, ListingStatus, PricingType } from '../../common/domain';
import { index, table } from '../database';
import type { DeliveryInfo, ProductVideo } from './values';

type Timestamps = { createdAt: Date; updatedAt: Date };

/** What a buyer can see: live and not deleted. Partial indexes below cover exactly this. */
const PUBLIC = { status: 'active', deletedAt: null };

/**
 * A listing. One collection backs the storefront's cards and detail page, the
 * seller's Products tab and the console's Items & Listing table.
 */
export type ProductRow = Timestamps & {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  /** The one-line summary on cards, derived from the description. */
  summary: string;
  /** "Additional Description" bullets / the spec list. */
  highlights: string[];
  /** A categories.slug. */
  categoryId: string;
  brand: string | null;
  condition: Condition;
  price: number;
  previousPrice: number | null;
  priceChangedAt: Date | null;
  previousPriceSince: Date | null;
  pricing: PricingType;
  paymentMethod: ListingPaymentMethod;
  delivery: DeliveryType;
  stock: number;
  location: string;
  images: string[];
  videos: ProductVideo[];
  status: ListingStatus;
  /* Moderation: why the listing was queued or flagged, and who reviewed it. */
  moderationFlags: string[];
  moderationNote: string | null;
  moderationReviewedBy: string | null;
  moderationReviewedAt: Date | null;
  listedAs: ListedAs;
  /** Curated onto the "Featured" rail by the console. */
  featured: boolean;
  /** Mirrors the seller's identity check, for the "Verified sellers" facet. */
  sellerVerified: boolean;
  /* Counters kept current by the modules that change them. */
  statsViews: number;
  /** Conversations started about the listing — the console's "inquiries". */
  statsInquiries: number;
  statsWishlists: number;
  /** Times a shopper put it in their cart (a new line, not a quantity bump). */
  statsCartAdds: number;
  /** Popular ranking: cart adds + units sold, kept in step with both. */
  statsPopularity: number;
  statsUnitsSold: number;
  statsRevenue: number;
  statsLastSaleAt: Date | null;
  statsRatingAverage: number;
  statsRatingCount: number;
  publishedAt: Date | null;
  deletedAt: Date | null;
};

export const products = table<ProductRow>()('products', {
  key: 'id',
  defaults: () => ({
    description: '',
    summary: '',
    highlights: [] as string[],
    pricing: 'fixed' as PricingType,
    paymentMethod: 'escrow' as ListingPaymentMethod,
    delivery: 'nationwide' as DeliveryType,
    stock: 0,
    location: 'Lagos',
    images: [] as string[],
    videos: [] as ProductVideo[],
    status: 'draft' as ListingStatus,
    moderationFlags: [] as string[],
    listedAs: 'seller' as ListedAs,
    featured: false,
    sellerVerified: false,
    statsViews: 0,
    statsInquiries: 0,
    statsWishlists: 0,
    statsCartAdds: 0,
    statsPopularity: 0,
    statsUnitsSold: 0,
    statsRevenue: 0,
    statsRatingAverage: 0,
    statsRatingCount: 0,
  }),
  nullable: [
    'brand',
    'previousPrice',
    'priceChangedAt',
    'previousPriceSince',
    'moderationNote',
    'moderationReviewedBy',
    'moderationReviewedAt',
    'statsLastSaleAt',
    'publishedAt',
    'deletedAt',
  ],
  indexes: [
    index('products_public_category_idx', { categoryId: 1, createdAt: -1 }, { partialFilterExpression: PUBLIC }),
    index('products_public_price_idx', { status: 1, price: 1 }),
    index('products_public_units_sold_idx', { status: 1, statsUnitsSold: -1 }),
    index('products_public_popularity_idx', { status: 1, statsPopularity: -1 }),
    index('products_public_views_idx', { status: 1, statsViews: -1 }),
    index('products_public_published_idx', { status: 1, publishedAt: -1 }),
    index('products_public_featured_idx', { status: 1, featured: 1, publishedAt: -1 }),
    index('products_seller_idx', { sellerId: 1, createdAt: -1 }),
    index('products_status_idx', { status: 1, createdAt: -1 }),
    /** Weighted full-text search: title, brand, summary, then location and description. */
    index(
      'products_search_idx',
      { title: 'text', brand: 'text', summary: 'text', location: 'text', description: 'text' },
      { weights: { title: 10, brand: 6, summary: 3, location: 1, description: 1 }, default_language: 'english' },
    ),
  ],
});

export type WishlistItemRow = Timestamps & {
  id: string;
  userId: string;
  productId: string;
  /** "Restock alerts on" — tell me when this is back in stock. */
  restockAlert: boolean;
};

export const wishlistItems = table<WishlistItemRow>()('wishlist_items', {
  key: 'id',
  defaults: () => ({ restockAlert: false }),
  indexes: [
    index('wishlist_items_user_product_key', { userId: 1, productId: 1 }, { unique: true }),
    index('wishlist_items_user_idx', { userId: 1, createdAt: -1 }),
    index('wishlist_items_product_idx', { productId: 1, restockAlert: 1 }),
  ],
});

/** One cart per user: the coupon and delivery details; the lines are in cart_items. */
export type CartRow = Timestamps & {
  userId: string;
  couponCode: string | null;
  delivery: DeliveryInfo | null;
};

export const carts = table<CartRow>()('carts', { key: 'userId', autoId: false, nullable: ['couponCode', 'delivery'] });

export type CartItemRow = {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  addedAt: Date;
};

export const cartItems = table<CartItemRow>()('cart_items', {
  key: 'id',
  timestamps: false,
  defaults: () => ({ addedAt: new Date() }),
  indexes: [index('cart_items_user_product_key', { userId: 1, productId: 1 }, { unique: true }), index('cart_items_product_idx', { productId: 1 })],
});

/** A platform discount code. DOOAA funds the discount; sellers are paid in full. */
export type CouponRow = Timestamps & {
  id: string;
  /** Always stored upper-cased. */
  code: string;
  description: string;
  type: CouponType;
  value: number;
  maxDiscount: number | null;
  minSubtotal: number | null;
  active: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  /** Total redemptions allowed across all buyers; null means unlimited. */
  maxRedemptions: number | null;
  redemptions: number;
};

export const coupons = table<CouponRow>()('coupons', {
  key: 'id',
  defaults: () => ({ description: '', active: true, redemptions: 0 }),
  nullable: ['maxDiscount', 'minSubtotal', 'startsAt', 'expiresAt', 'maxRedemptions'],
  indexes: [index('coupons_code_key', { code: 1 }, { unique: true })],
});
