import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { CONDITIONS, PRICE_BANDS, type Condition, type PriceBand, type SortKey } from '../../common/domain';
import { products } from '../../database/schema';
import { containsText, descNullsLast } from '../../database/sql';

/** What a buyer can see: live, not deleted. */
export const PUBLIC_PRODUCT_FILTER: SQL = and(eq(products.status, 'active'), isNull(products.deletedAt))!;

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

function tsQuery(term: string): SQL {
  return sql`websearch_to_tsquery('english', ${term})`;
}

/**
 * Builds the catalog's WHERE clause. Full-text mode matches whole words
 * through the weighted `search` document; partial mode catches word
 * fragments ("iph") when full-text finds nothing.
 */
export function buildCatalogFilter(query: CatalogQuery, mode: SearchMode = 'text'): SQL {
  const conditions: SQL[] = [PUBLIC_PRODUCT_FILTER];

  const term = searchTerm(query);
  if (term && mode === 'text') conditions.push(sql`${products.search} @@ ${tsQuery(term)}`);
  if (term && mode === 'partial') {
    conditions.push(or(containsText(products.title, term), containsText(products.brand, term), containsText(products.summary, term), containsText(products.location, term))!);
  }

  if (query.category?.length) conditions.push(inArray(products.categoryId, query.category));
  if (query.collection === 'featured') conditions.push(eq(products.featured, true));
  if (query.collection === 'top-sellers') conditions.push(gt(products.statsUnitsSold, 0));

  if (query.condition?.length) {
    const conditionValues = query.condition.map(normalizeCondition).filter((value): value is Condition => Boolean(value));
    conditions.push(conditionValues.length ? inArray(products.condition, conditionValues) : sql`false`);
  }

  if (query.brand?.length) conditions.push(inArray(sql`lower(${products.brand})`, query.brand.map((brand) => brand.trim().toLowerCase())));

  const verified = sellerVerificationFilter(query.seller);
  if (verified !== null) conditions.push(eq(products.sellerVerified, verified));

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
  if (min !== undefined) conditions.push(gte(products.price, min));
  if (max !== undefined) conditions.push(lte(products.price, max));
  if (below !== undefined) conditions.push(lt(products.price, below));
  if (query.inStock) conditions.push(gt(products.stock, 0));

  return and(...conditions)!;
}

export function catalogSort(query: CatalogQuery, mode: SearchMode): SQL[] {
  switch (query.sort) {
    case 'price-asc':
      return [asc(products.price), asc(products.id)];
    case 'price-desc':
      return [desc(products.price), asc(products.id)];
    case 'newest':
      return [descNullsLast(products.publishedAt), desc(products.createdAt), desc(products.id)];
    case 'oldest':
      return [asc(products.publishedAt), asc(products.createdAt), asc(products.id)];
    default:
      break;
  }
  if (query.collection === 'top-sellers') return [desc(products.statsUnitsSold), desc(products.statsRatingAverage), desc(products.id)];
  if (query.collection === 'popular') return [desc(products.statsViews), desc(products.statsWishlists), desc(products.id)];
  const term = searchTerm(query);
  if (mode === 'text' && term) return [sql`ts_rank(${products.search}, ${tsQuery(term)}) desc`, desc(products.id)];
  return [desc(products.featured), descNullsLast(products.publishedAt), desc(products.createdAt), desc(products.id)];
}
