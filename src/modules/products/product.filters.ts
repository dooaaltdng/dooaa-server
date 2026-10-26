import type { Sort } from 'mongodb';
import { CONDITIONS, PRICE_BANDS, type Condition, type PriceBand, type SortKey } from '../../common/domain';
import { containsText, type Where } from '../../database/database';
import type { ProductRow } from '../../database/schema';
import { expandSearch } from './search-synonyms';

/** What a buyer can see: live, not deleted. */
export const PUBLIC_PRODUCT_FILTER = { status: 'active', deletedAt: null } as const satisfies Where<ProductRow>;

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

/** How a search term is matched: full-text (whole words, ranked), substring (partial words), or not at all. */
export type SearchMode = 'text' | 'partial' | 'none';

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


/** The search term as the catalog uses it: trimmed and bounded. */
export function searchTerm(query: Pick<CatalogQuery, 'q'>): string | undefined {
  return query.q?.trim().slice(0, 80) || undefined;
}

/**
 * Builds the catalog's filter. Full-text mode matches whole words through
 * the weighted text index; partial mode catches word fragments ("iph") when
 * full-text finds nothing.
 */
export function buildCatalogFilter(query: CatalogQuery, mode: SearchMode = 'text'): Where<ProductRow> {
  const filter: Where<ProductRow> = { ...PUBLIC_PRODUCT_FILTER };
  const and: Where<ProductRow>[] = [];

  const term = searchTerm(query);
  // Synonyms widen the full-text match ("phone" also finds Galaxy and Tecno listings); ranking still uses textScore.
  if (term && mode === 'text') filter.$text = { $search: expandSearch(term) };
  if (term && mode === 'partial') {
    const match = containsText(term);
    and.push({ $or: [{ title: match }, { brand: match }, { summary: match }, { location: match }] });
  }

  if (query.category?.length) filter.categoryId = { $in: query.category };
  if (query.collection === 'featured') filter.featured = true;
  // Top sellers lists everything, best-selling first (see the sort); popular needs a cart add or a sale.
  if (query.collection === 'popular') filter.statsPopularity = { $gt: 0 };

  if (query.condition?.length) {
    const conditionValues = query.condition.map(normalizeCondition).filter((value): value is Condition => Boolean(value));
    filter.condition = { $in: conditionValues };
  }

  if (query.brand?.length) {
    and.push({ $or: query.brand.map((brand) => ({ brand: { $regex: `^${escapeForRegex(brand.trim())}$`, $options: 'i' } })) });
  }

  const verified = sellerVerificationFilter(query.seller);
  if (verified !== null) filter.sellerVerified = verified;

  let min = query.min;
  let max = query.max;
  let below: number | undefined;
  if (query.price && query.price !== 'any') {
    const band = PRICE_BANDS[query.price];
    if (band) {
      min = Math.max(min ?? 0, band.min);
      if (Number.isFinite(band.max)) below = band.max;
    }
  }
  const price: Record<string, number> = {};
  if (min !== undefined) price.$gte = min;
  if (max !== undefined) price.$lte = max;
  if (below !== undefined) price.$lt = below;
  if (Object.keys(price).length) filter.price = price;
  if (query.inStock) filter.stock = { $gt: 0 };

  if (and.length) filter.$and = and;
  return filter;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function catalogSort(query: CatalogQuery, mode: SearchMode): Sort {
  switch (query.sort) {
    case 'price-asc':
      return { price: 1, _id: 1 };
    case 'price-desc':
      return { price: -1, _id: 1 };
    case 'newest':
      return { publishedAt: -1, createdAt: -1, _id: -1 };
    case 'oldest':
      return { publishedAt: 1, createdAt: 1, _id: 1 };
    default:
      break;
  }
  if (query.collection === 'top-sellers') return { statsUnitsSold: -1, statsRatingAverage: -1, _id: -1 };
  if (query.collection === 'popular') return { statsPopularity: -1, statsUnitsSold: -1, statsViews: -1, _id: -1 };
  const term = searchTerm(query);
  if (mode === 'text' && term) return { score: { $meta: 'textScore' }, _id: -1 };
  return { featured: -1, publishedAt: -1, createdAt: -1, _id: -1 };
}
