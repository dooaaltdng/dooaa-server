import type { QueryFilter } from 'mongoose';
import { CONDITIONS, PRICE_BANDS, type Condition, type PriceBand, type SortKey } from '../../common/domain';
import { escapeRegex } from '../../common/util/text';
import type { Product } from './schemas/product.schema';

/** What a buyer can see: live, not deleted. */
export const PUBLIC_PRODUCT_FILTER = { status: 'active', deletedAt: null } as const;

export type CatalogQuery = {
  q?: string;
  category?: string[];
  sort?: SortKey;
  price?: PriceBand;
  condition?: string[];
  brand?: string[];
  seller?: string[];
  min?: number;
  max?: number;
  collection?: string;
  inStock?: boolean;
};

/** "Brand New" on the sidebar and "New" on cards are both `new`. */
export function normalizeCondition(value: string): Condition | null {
  const key = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (key === 'new' || key === 'brand-new') return 'new';
  if ((CONDITIONS as readonly string[]).includes(key)) return key as Condition;
  return null;
}

/** "Verified sellers" / "verified" → true; "Unverified sellers" / "unverified" → false; both → no filter. */
export function sellerVerificationFilter(values: string[] | undefined): boolean | null {
  if (!values?.length) return null;
  const normalized = values.map((value) => value.toLowerCase());
  const verified = normalized.some((value) => value.startsWith('verified'));
  const unverified = normalized.some((value) => value.startsWith('unverified'));
  return verified === unverified ? null : verified;
}

/**
 * Builds the catalog's Mongo filter. `textMode` uses the full-text index
 * (whole words, relevance-ranked); the regex mode catches partial words
 * ("iph") when full-text finds nothing.
 */
export function buildCatalogFilter(query: CatalogQuery, textMode: 'text' | 'regex' | 'none' = 'text'): QueryFilter<Product> {
  const filter: Record<string, unknown> = { ...PUBLIC_PRODUCT_FILTER };
  const and: Record<string, unknown>[] = [];

  const term = query.q?.trim().slice(0, 80);
  if (term && textMode === 'text') filter.$text = { $search: term };
  if (term && textMode === 'regex') {
    const pattern = new RegExp(escapeRegex(term), 'i');
    and.push({ $or: [{ title: pattern }, { brand: pattern }, { summary: pattern }, { location: pattern }] });
  }

  if (query.category?.length) filter.categoryId = { $in: query.category };
  if (query.collection === 'featured') filter.featured = true;
  if (query.collection === 'top-sellers') filter['stats.unitsSold'] = { $gt: 0 };

  const conditions = (query.condition ?? []).map(normalizeCondition).filter((value): value is Condition => Boolean(value));
  if (query.condition?.length) filter.condition = { $in: conditions };

  if (query.brand?.length) filter.brand = { $in: query.brand.map((brand) => new RegExp(`^${escapeRegex(brand)}$`, 'i')) };

  const verified = sellerVerificationFilter(query.seller);
  if (verified !== null) filter.sellerVerified = verified;

  const price: Record<string, number> = {};
  if (query.min !== undefined) price.$gte = query.min;
  if (query.max !== undefined) price.$lte = query.max;
  if (query.price && query.price !== 'any') {
    const band = PRICE_BANDS[query.price];
    if (band) {
      price.$gte = Math.max(price.$gte ?? 0, band.min);
      if (Number.isFinite(band.max)) price.$lt = band.max;
    }
  }
  if (Object.keys(price).length) filter.price = price;
  if (query.inStock) filter.stock = { $gt: 0 };

  if (and.length) filter.$and = and;
  return filter as QueryFilter<Product>;
}

export function catalogSort(query: CatalogQuery, textMode: 'text' | 'regex' | 'none'): Record<string, 1 | -1 | { $meta: 'textScore' }> {
  switch (query.sort) {
    case 'price-asc':
      return { price: 1, _id: 1 };
    case 'price-desc':
      return { price: -1, _id: 1 };
    case 'newest':
      return { publishedAt: -1, createdAt: -1, _id: -1 };
    default:
      break;
  }
  if (query.collection === 'top-sellers') return { 'stats.unitsSold': -1, 'stats.ratingAverage': -1, _id: -1 };
  if (query.collection === 'popular') return { 'stats.views': -1, 'stats.wishlists': -1, _id: -1 };
  if (textMode === 'text') return { score: { $meta: 'textScore' }, _id: -1 };
  return { featured: -1, publishedAt: -1, createdAt: -1, _id: -1 };
}
