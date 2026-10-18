import { getTableColumns } from 'drizzle-orm';
import type { Condition, DeliveryType, ListedAs, ListingPaymentMethod, ListingStatus, PricingType } from '../../common/domain';
import { products, type ProductVideo } from '../../database/schema';

export type ProductModeration = {
  /** Why the listing was queued or flagged: unverified-seller, review-category, high-value, price-outlier, seller-restricted… */
  flags: string[];
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
};

export type ProductStats = {
  views: number;
  /** Conversations started about the listing — the console's "inquiries". */
  inquiries: number;
  wishlists: number;
  unitsSold: number;
  revenue: number;
  lastSaleAt: Date | null;
  ratingAverage: number;
  ratingCount: number;
};

/**
 * A listing as the services and presenters see it. One model backs the
 * storefront's cards and detail page, the seller's Products tab and the
 * console's Items & Listing table.
 */
export type Product = {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  summary: string;
  highlights: string[];
  /** The category's slug. */
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
  moderation: ProductModeration;
  listedAs: ListedAs;
  featured: boolean;
  sellerVerified: boolean;
  stats: ProductStats;
  publishedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const { search: _search, ...columns } = getTableColumns(products);

/** Every product column except the full-text document — what reads select. */
export const productColumns = columns;

export type ProductRow = Omit<typeof products.$inferSelect, 'search'>;

export function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sellerId: row.sellerId,
    title: row.title,
    description: row.description,
    summary: row.summary,
    highlights: row.highlights,
    categoryId: row.categoryId,
    brand: row.brand,
    condition: row.condition,
    price: row.price,
    previousPrice: row.previousPrice,
    priceChangedAt: row.priceChangedAt,
    previousPriceSince: row.previousPriceSince,
    pricing: row.pricing,
    paymentMethod: row.paymentMethod,
    delivery: row.delivery,
    stock: row.stock,
    location: row.location,
    images: row.images,
    videos: row.videos,
    status: row.status,
    moderation: {
      flags: row.moderationFlags,
      note: row.moderationNote,
      reviewedBy: row.moderationReviewedBy,
      reviewedAt: row.moderationReviewedAt,
    },
    listedAs: row.listedAs,
    featured: row.featured,
    sellerVerified: row.sellerVerified,
    stats: {
      views: row.statsViews,
      inquiries: row.statsInquiries,
      wishlists: row.statsWishlists,
      unitsSold: row.statsUnitsSold,
      revenue: row.statsRevenue,
      lastSaleAt: row.statsLastSaleAt,
      ratingAverage: row.statsRatingAverage,
      ratingCount: row.statsRatingCount,
    },
    publishedAt: row.publishedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
