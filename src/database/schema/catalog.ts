import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { money, primaryId, timestamps, timestamptz, tsvector } from './columns';
import { couponType, deliveryType, listedAs, listingPaymentMethod, listingStatus, pricingType, productCondition } from './enums';
import { staff, users } from './identity';
import { categories } from './platform';
import type { DeliveryInfo, ProductVideo } from './values';

/** What a buyer can see: live and not deleted. Partial indexes below cover exactly this. */
const PUBLIC = sql`status = 'active' and deleted_at is null`;

/**
 * A listing. One table backs the storefront's cards and detail page, the
 * seller's Products tab and the console's Items & Listing table.
 */
export const products = pgTable(
  'products',
  {
    id: primaryId(),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    description: text().notNull().default(''),
    /** The one-line summary on cards, derived from the description. */
    summary: text().notNull().default(''),
    /** "Additional Description" bullets / the spec list. */
    highlights: text().array().notNull().default(sql`'{}'::text[]`),
    categoryId: text()
      .notNull()
      .references(() => categories.slug, { onDelete: 'restrict', onUpdate: 'cascade' }),
    brand: text(),
    condition: productCondition().notNull(),
    price: money().notNull(),
    previousPrice: money(),
    priceChangedAt: timestamptz(),
    previousPriceSince: timestamptz(),
    pricing: pricingType().notNull().default('fixed'),
    paymentMethod: listingPaymentMethod().notNull().default('escrow'),
    delivery: deliveryType().notNull().default('nationwide'),
    stock: integer().notNull().default(0),
    location: text().notNull().default('Lagos'),
    images: text().array().notNull().default(sql`'{}'::text[]`),
    videos: jsonb().$type<ProductVideo[]>().notNull().default([]),
    status: listingStatus().notNull().default('draft'),

    /* Moderation: why the listing was queued or flagged, and who reviewed it. */
    moderationFlags: text().array().notNull().default(sql`'{}'::text[]`),
    moderationNote: text(),
    moderationReviewedBy: uuid().references(() => staff.id, { onDelete: 'set null' }),
    moderationReviewedAt: timestamptz(),

    listedAs: listedAs().notNull().default('seller'),
    /** Curated onto the "Featured" rail by the console. */
    featured: boolean().notNull().default(false),
    /** Mirrors the seller's identity check, for the "Verified sellers" facet. */
    sellerVerified: boolean().notNull().default(false),

    /* Counters kept current by the modules that change them. */
    statsViews: integer().notNull().default(0),
    /** Conversations started about the listing — the console's "inquiries". */
    statsInquiries: integer().notNull().default(0),
    statsWishlists: integer().notNull().default(0),
    statsUnitsSold: integer().notNull().default(0),
    statsRevenue: numeric({ precision: 16, scale: 2, mode: 'number' }).notNull().default(0),
    statsLastSaleAt: timestamptz(),
    statsRatingAverage: doublePrecision().notNull().default(0),
    statsRatingCount: integer().notNull().default(0),

    publishedAt: timestamptz(),
    deletedAt: timestamptz(),
    ...timestamps,

    /** Weighted full-text document for catalog search: title, brand, summary, then location and description. */
    search: tsvector()
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(brand, '')), 'B') || setweight(to_tsvector('english', coalesce(summary, '')), 'C') || setweight(to_tsvector('english', coalesce(location, '') || ' ' || coalesce(description, '')), 'D')`,
      ),
  },
  (t) => [
    index('products_public_category_idx').on(t.categoryId, t.createdAt.desc()).where(PUBLIC),
    index('products_public_price_idx').on(t.price).where(PUBLIC),
    index('products_public_units_sold_idx').on(t.statsUnitsSold.desc()).where(PUBLIC),
    index('products_public_views_idx').on(t.statsViews.desc()).where(PUBLIC),
    index('products_public_published_idx').on(t.publishedAt.desc()).where(PUBLIC),
    index('products_public_featured_idx').on(t.featured, t.publishedAt.desc()).where(PUBLIC),
    index('products_seller_idx').on(t.sellerId, t.createdAt.desc()).where(sql`deleted_at is null`),
    index('products_status_idx').on(t.status, t.createdAt.desc()),
    index('products_search_idx').using('gin', t.search),
    index('products_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    index('products_brand_trgm_idx').using('gin', t.brand.op('gin_trgm_ops')),
    check('products_price_nonnegative', sql`${t.price} >= 0`),
    check('products_stock_nonnegative', sql`${t.stock} >= 0`),
  ],
);

export const wishlistItems = pgTable(
  'wishlist_items',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** "Restock alerts on" — tell me when this is back in stock. */
    restockAlert: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('wishlist_items_user_product_key').on(t.userId, t.productId),
    index('wishlist_items_user_idx').on(t.userId, t.createdAt.desc()),
    index('wishlist_items_product_idx').on(t.productId, t.restockAlert),
  ],
);

/** One cart per user: the coupon and delivery details; the lines are in cart_items. */
export const carts = pgTable('carts', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  couponCode: text(),
  delivery: jsonb().$type<DeliveryInfo>(),
  ...timestamps,
});

export const cartItems = pgTable(
  'cart_items',
  {
    userId: uuid()
      .notNull()
      .references(() => carts.userId, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantity: integer().notNull(),
    addedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    index('cart_items_product_idx').on(t.productId),
    check('cart_items_quantity_positive', sql`${t.quantity} >= 1`),
  ],
);

/** A platform discount code. DOOAA funds the discount; sellers are paid in full. */
export const coupons = pgTable(
  'coupons',
  {
    id: primaryId(),
    /** Always stored upper-cased. */
    code: text().notNull(),
    description: text().notNull().default(''),
    type: couponType().notNull(),
    value: money().notNull(),
    maxDiscount: money(),
    minSubtotal: money(),
    active: boolean().notNull().default(true),
    startsAt: timestamptz(),
    expiresAt: timestamptz(),
    /** Total redemptions allowed across all buyers; null means unlimited. */
    maxRedemptions: integer(),
    redemptions: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('coupons_code_key').on(t.code),
    check('coupons_code_uppercase', sql`${t.code} = upper(${t.code})`),
    check('coupons_value_nonnegative', sql`${t.value} >= 0`),
  ],
);
