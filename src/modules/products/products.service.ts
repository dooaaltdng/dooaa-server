import { Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, max, min, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { CacheService } from '../../cache/cache.service';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { ListingStatus } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { excerpt } from '../../common/util/text';
import { isUuid } from '../../common/util/uuid';
import { containsText, InjectDb, isUniqueViolation, type Database, type Executor } from '../../database/database';
import { products, users, wishlistItems } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { MediaService } from '../media/media.service';
import { SettingsService } from '../settings/settings.service';
import type { User } from '../users/user.model';
import { UsersService } from '../users/users.service';
import type { CreateProductDto, SellerStatusFilter, UpdateProductDto } from './dto/product.dto';
import { PUBLIC_PRODUCT_FILTER, buildCatalogFilter, catalogSort, searchTerm, type CatalogQuery, type SearchMode } from './product.filters';
import { productColumns, toProduct, type Product } from './product.model';
import {
  toAdminListing,
  toProductCard,
  toProductDetail,
  toSellerProduct,
  type AdminListingView,
  type ProductCard,
  type ProductDetail,
  type SellerProductView,
} from './product.presenter';

export const PRODUCT_EVENTS = {
  restocked: 'product.restocked',
  flagged: 'product.flagged',
  viewed: 'product.viewed',
  statusChanged: 'product.status-changed',
} as const;

export type ProductRestocked = { productId: string; title: string };
export type ProductFlagged = { productId: string; title: string; reasons: string[]; price: number };
export type ProductViewed = { productId: string; sellerId: string };
export type ProductStatusChanged = { productId: string; sellerId: string; title: string; from: ListingStatus; to: ListingStatus; note?: string; by: 'seller' | 'staff' | 'system' };

export type CatalogFacets = {
  brands: { value: string; count: number }[];
  conditions: { value: string; count: number }[];
  sellers: { verified: number; unverified: number };
  price: { min: number; max: number };
};

export type SellerTabCounts = { all: number; active: number; inactive: number; draft: number };

type ProductPatch = PgUpdateSetSource<typeof products>;
type HomeRails = { topSellers: Product[]; featured: Product[]; popular: Product[] };

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const MIN_LISTINGS_FOR_OUTLIER = 5;
const HOME_KEY = 'catalog:home';
const HOME_TTL_MS = 60_000;
const MEDIAN_TTL_MS = 5 * 60_000;

type Viewer = { id: string } | undefined;

const medianKey = (categoryId: string) => `catalog:median:${categoryId}`;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly users: UsersService,
    private readonly categories: CategoriesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly events: EventBus,
  ) {}

  /* --- Lookups ----------------------------------------------------------------- */

  private async select(where: SQL | undefined, orderBy: SQL[] = [], limit?: number, offset?: number): Promise<Product[]> {
    let query = this.db.select(productColumns).from(products).where(where).$dynamic();
    if (orderBy.length) query = query.orderBy(...orderBy);
    if (limit !== undefined) query = query.limit(limit);
    if (offset !== undefined) query = query.offset(offset);
    return (await query).map(toProduct);
  }

  private async countWhere(where: SQL | undefined): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(products).where(where);
    return row.total;
  }

  async findById(id: string): Promise<Product | null> {
    if (!isUuid(id)) return null;
    const [product] = await this.select(and(eq(products.id, id), isNull(products.deletedAt)), [], 1);
    return product ?? null;
  }

  async findPublic(id: string): Promise<Product> {
    const [product] = isUuid(id) ? await this.select(and(eq(products.id, id), PUBLIC_PRODUCT_FILTER), [], 1) : [];
    if (!product) throw Errors.notFound('This item is no longer listed.', 'PRODUCT_NOT_FOUND');
    return product;
  }

  /** Every listing in the list, including unavailable ones, by id. */
  async byIds(ids: string[]): Promise<Product[]> {
    const valid = [...new Set(ids.filter(isUuid))];
    return valid.length ? this.select(inArray(products.id, valid)) : [];
  }

  private async wishlistedSet(viewer: Viewer, ids: string[]): Promise<Set<string>> {
    if (!viewer || !ids.length) return new Set();
    const rows = await this.db
      .select({ productId: wishlistItems.productId })
      .from(wishlistItems)
      .where(and(eq(wishlistItems.userId, viewer.id), inArray(wishlistItems.productId, ids)));
    return new Set(rows.map((row) => row.productId));
  }

  async toCards(list: Product[], viewer?: Viewer): Promise<ProductCard[]> {
    const [categoryNames, wishlisted] = await Promise.all([
      this.categories.names(),
      this.wishlistedSet(
        viewer,
        list.map((product) => product.id),
      ),
    ]);
    return list.map((product) => toProductCard(product, { categoryNames, wishlisted }));
  }

  /** Cards for a list of ids, in the order given; ids that no longer resolve are dropped. */
  async cardsByIds(ids: string[], viewer?: Viewer, includeUnavailable = false): Promise<ProductCard[]> {
    const valid = ids.filter(isUuid);
    if (!valid.length) return [];
    const rows = await this.select(and(inArray(products.id, valid), isNull(products.deletedAt), includeUnavailable ? undefined : eq(products.status, 'active')));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = valid.map((id) => byId.get(id)).filter((row): row is Product => Boolean(row));
    return this.toCards(ordered, viewer);
  }

  /* --- Storefront -------------------------------------------------------------- */

  async search(query: CatalogQuery & { page?: number; limit?: number }, viewer?: Viewer): Promise<Page<ProductCard> & { facets: CatalogFacets }> {
    const size = query.limit ?? 24;
    let mode: SearchMode = searchTerm(query) ? 'text' : 'none';
    let total = await this.countWhere(buildCatalogFilter(query, mode));
    if (total === 0 && mode === 'text') {
      // Full-text matches whole words only; fall back to a substring match for partial words.
      mode = 'partial';
      total = await this.countWhere(buildCatalogFilter(query, mode));
    }
    const window = pageWindow(total, query.page, size);
    const [rows, facets] = await Promise.all([
      this.select(buildCatalogFilter(query, mode), catalogSort(query, mode), window.size, window.skip),
      this.facets(buildCatalogFilter({ q: query.q, category: query.category, price: query.price, min: query.min, max: query.max, collection: query.collection }, mode)),
    ]);
    return { ...toPage(await this.toCards(rows, viewer), total, window), facets };
  }

  private async facets(filter: SQL): Promise<CatalogFacets> {
    const [brands, conditions, sellers, [price]] = await Promise.all([
      this.db
        .select({ value: products.brand, count: count() })
        .from(products)
        .where(and(filter, sql`coalesce(${products.brand}, '') <> ''`))
        .groupBy(products.brand)
        .orderBy(desc(count()), asc(products.brand))
        .limit(20),
      this.db.select({ value: products.condition, count: count() }).from(products).where(filter).groupBy(products.condition).orderBy(asc(products.condition)),
      this.db.select({ verified: products.sellerVerified, count: count() }).from(products).where(filter).groupBy(products.sellerVerified),
      this.db.select({ min: min(products.price), max: max(products.price) }).from(products).where(filter),
    ]);
    return {
      brands: brands.map((row) => ({ value: row.value!, count: row.count })),
      conditions: conditions.map((row) => ({ value: row.value, count: row.count })),
      sellers: {
        verified: sellers.find((row) => row.verified)?.count ?? 0,
        unverified: sellers.find((row) => !row.verified)?.count ?? 0,
      },
      price: { min: price?.min ?? 0, max: price?.max ?? 0 },
    };
  }

  /** Header search-as-you-type: words in titles and brands that start with what was typed. */
  async suggest(q: string): Promise<{ id: string; title: string; categoryId: string; image: string | null }[]> {
    const term = escapeLike(q.trim());
    const startsWord = (column: typeof products.title | typeof products.brand) => or(sql`${column} ilike ${`${term}%`}`, sql`${column} ilike ${`% ${term}%`}`)!;
    const rows = await this.db
      .select({ id: products.id, title: products.title, categoryId: products.categoryId, images: products.images })
      .from(products)
      .where(and(PUBLIC_PRODUCT_FILTER, or(startsWord(products.title), startsWord(products.brand))))
      .orderBy(desc(products.statsViews), desc(products.id))
      .limit(8);
    return rows.map((row) => ({ id: row.id, title: row.title, categoryId: row.categoryId, image: row.images[0] ?? null }));
  }

  /** The landing page: category tiles and the three rails. */
  async homepage(viewer?: Viewer) {
    const rails = await this.cache.wrap<HomeRails>(HOME_KEY, HOME_TTL_MS, async () => {
      const base = and(PUBLIC_PRODUCT_FILTER, gt(products.stock, 0))!;
      const [topSellers, featuredFlagged, popular] = await Promise.all([
        this.select(base, [desc(products.statsUnitsSold), desc(products.statsRatingAverage), descNullsLast(products.publishedAt)], 8),
        this.select(and(base, eq(products.featured, true)), [descNullsLast(products.publishedAt)], 8),
        this.select(base, [desc(products.statsViews), desc(products.statsWishlists), descNullsLast(products.publishedAt)], 8),
      ]);
      // Until enough listings are curated, the Featured rail tops up with the newest verified ones.
      let featured = featuredFlagged;
      if (featured.length < 8) {
        const extra = await this.select(
          and(base, eq(products.sellerVerified, true), featured.length ? notInArray(products.id, featured.map((row) => row.id)) : undefined),
          [descNullsLast(products.publishedAt), desc(products.createdAt)],
          8 - featured.length,
        );
        featured = [...featured, ...extra];
      }
      return { topSellers, featured, popular };
    });
    const [categoryTiles, topSellers, featured, popular] = await Promise.all([
      this.categories.homeTiles(),
      this.toCards(rails.topSellers, viewer),
      this.toCards(rails.featured, viewer),
      this.toCards(rails.popular, viewer),
    ]);
    return { categories: categoryTiles, topSellers, featured, popular };
  }

  async detail(id: string, viewer?: Viewer): Promise<ProductDetail & { alsoViewed: ProductCard[] }> {
    const product = await this.findPublic(id);
    const [seller, categoryNames, wishlisted, related] = await Promise.all([
      this.users.findById(product.sellerId),
      this.categories.names(),
      this.wishlistedSet(viewer, [product.id]),
      this.select(and(PUBLIC_PRODUCT_FILTER, eq(products.categoryId, product.categoryId), ne(products.id, product.id)), [desc(products.statsViews), descNullsLast(products.publishedAt)], 3),
    ]);
    if (!viewer || viewer.id !== product.sellerId) {
      void this.db
        .update(products)
        .set({ statsViews: sql`${products.statsViews} + 1` })
        .where(eq(products.id, product.id))
        .catch(() => undefined);
      this.events.publish<ProductViewed>(PRODUCT_EVENTS.viewed, { productId: product.id, sellerId: product.sellerId });
    }
    return {
      ...toProductDetail(product, seller, { categoryNames, wishlisted }),
      alsoViewed: await this.toCards(related, viewer),
    };
  }

  /** A seller's public storefront listings. */
  async bySeller(sellerId: string, page = 1, limit = 24, viewer?: Viewer): Promise<Page<ProductCard>> {
    if (!isUuid(sellerId)) throw Errors.notFound('That seller is not on DOOAA.', 'SELLER_NOT_FOUND');
    const where = and(PUBLIC_PRODUCT_FILTER, eq(products.sellerId, sellerId));
    const total = await this.countWhere(where);
    const window = pageWindow(total, page, limit);
    const rows = await this.select(where, [descNullsLast(products.publishedAt), desc(products.id)], window.size, window.skip);
    return toPage(await this.toCards(rows, viewer), total, window);
  }

  /* --- Moderation ------------------------------------------------------------ */

  /** Median live price in a category, for the "Suspicious" price check. Null when there are too few listings to judge. */
  private categoryMedian(categoryId: string): Promise<number | null> {
    return this.cache.wrap(medianKey(categoryId), MEDIAN_TTL_MS, async () => {
      const where = and(PUBLIC_PRODUCT_FILTER, eq(products.categoryId, categoryId));
      const total = await this.countWhere(where);
      if (total < MIN_LISTINGS_FOR_OUTLIER) return null;
      const [middle] = await this.db
        .select({ price: products.price })
        .from(products)
        .where(where)
        .orderBy(asc(products.price))
        .offset(Math.floor(total / 2))
        .limit(1);
      return middle?.price ?? null;
    });
  }

  /**
   * Where a listing lands when its seller publishes it. Live straight away
   * only when nothing about it needs a second look.
   */
  async moderationDecision(seller: Pick<User, 'identity' | 'verificationLevel'>, product: Pick<Product, 'categoryId' | 'price'>): Promise<{ status: ListingStatus; flags: string[] }> {
    const settings = await this.settings.get();
    const flags: string[] = [];
    const median = await this.categoryMedian(product.categoryId);
    if (median !== null && product.price > median * settings.moderation.suspiciousPriceMultiple) {
      return { status: 'suspicious', flags: ['price-outlier'] };
    }
    if (seller.identity !== 'verified') flags.push('unverified-seller');
    if (settings.moderation.reviewCategories.includes(product.categoryId)) flags.push('review-category');
    if (product.price > settings.moderation.requireKycAboveAmount && seller.verificationLevel !== 'high-value') flags.push('high-value');
    if (!settings.moderation.autoPublishListings) flags.push('manual-review');
    return { status: flags.length ? 'pending' : 'active', flags };
  }

  private async assertListable(input: { categoryId?: string; paymentMethod?: string }): Promise<void> {
    if (input.categoryId !== undefined) {
      const settings = await this.settings.get();
      if (!(await this.categories.exists(input.categoryId))) throw Errors.badRequest('Choose a category from the list.', 'UNKNOWN_CATEGORY');
      if (!settings.marketplace.activeCategories.includes(input.categoryId)) {
        throw Errors.badRequest('That category is not accepting new listings right now.', 'CATEGORY_CLOSED');
      }
    }
    if (input.paymentMethod === 'escrow' && !(await this.settings.section('escrow')).enabled) {
      throw Errors.badRequest('Escrow is switched off right now. Choose the default payment method.', 'ESCROW_DISABLED');
    }
  }

  async recountActiveListings(sellerId: string): Promise<void> {
    const total = await this.countWhere(and(eq(products.sellerId, sellerId), eq(products.status, 'active'), isNull(products.deletedAt)));
    await this.users.setStats(sellerId, { activeListings: total });
  }

  private async afterChange(product: Pick<Product, 'categoryId' | 'sellerId'>): Promise<void> {
    await Promise.all([this.categories.invalidateCounts(), this.cache.delete(HOME_KEY, medianKey(product.categoryId))]);
    void this.recountActiveListings(product.sellerId).catch(() => undefined);
  }

  private flagIfSuspicious(product: Product): void {
    if (product.status === 'suspicious') {
      this.events.publish<ProductFlagged>(PRODUCT_EVENTS.flagged, {
        productId: product.id,
        title: product.title,
        reasons: product.moderation.flags,
        price: product.price,
      });
    }
  }

  private async patch(id: string, set: ProductPatch, condition?: SQL): Promise<Product | null> {
    const [row] = await this.db
      .update(products)
      .set(set)
      .where(and(eq(products.id, id), condition))
      .returning(productColumns);
    return row ? toProduct(row) : null;
  }

  /* --- Seller tools ------------------------------------------------------------ */

  private async sellerRecord(seller: AuthUser): Promise<User> {
    const record = await this.users.findById(seller.id);
    if (!record) throw Errors.unauthorized();
    return record;
  }

  /** The console can cap how many listings a seller has live or in review at once. */
  private async assertUnderListingLimit(record: User, excludeId?: string): Promise<void> {
    const limit = record.seller.listingLimit;
    if (limit === null) return;
    const live = await this.countWhere(
      and(
        eq(products.sellerId, record.id),
        isNull(products.deletedAt),
        inArray(products.status, ['active', 'pending', 'suspicious']),
        excludeId ? ne(products.id, excludeId) : undefined,
      ),
    );
    if (live >= limit) {
      throw Errors.forbidden(
        limit === 0
          ? 'Your account cannot publish listings right now. Contact support for details.'
          : `You can have up to ${limit} live listing${limit === 1 ? '' : 's'} at a time. Unpublish one or contact support to raise the limit.`,
        'LISTING_LIMIT_REACHED',
      );
    }
  }

  private async ownProduct(seller: AuthUser, id: string): Promise<Product> {
    const [product] = isUuid(id) ? await this.select(and(eq(products.id, id), eq(products.sellerId, seller.id), isNull(products.deletedAt)), [], 1) : [];
    if (!product) throw Errors.notFound('That product is not in your store.', 'PRODUCT_NOT_FOUND');
    return product;
  }

  async sellerList(
    seller: AuthUser,
    query: { tab?: 'all' | 'active' | 'inactive' | 'draft'; q?: string; status?: SellerStatusFilter; page?: number; limit?: number },
  ): Promise<Page<SellerProductView> & { counts: SellerTabCounts }> {
    const base = and(eq(products.sellerId, seller.id), isNull(products.deletedAt), query.q?.trim() ? containsText(products.title, query.q) : undefined)!;
    const tabs: Record<'all' | 'active' | 'inactive' | 'draft', SQL | undefined> = {
      all: undefined,
      active: and(eq(products.status, 'active'), gt(products.stock, 0)),
      // "Inactive Products" gathers everything a buyer cannot purchase right now.
      inactive: or(inArray(products.status, ['pending', 'inactive', 'suspicious', 'rejected']), and(eq(products.status, 'active'), lte(products.stock, 0))),
      draft: eq(products.status, 'draft'),
    };
    // The pill a listing shows: flagged listings wait on review like new ones.
    const statuses: Record<SellerStatusFilter, SQL | undefined> = {
      active: and(eq(products.status, 'active'), gt(products.stock, 0)),
      'out-of-stock': and(eq(products.status, 'active'), lte(products.stock, 0)),
      pending: inArray(products.status, ['pending', 'suspicious']),
      draft: eq(products.status, 'draft'),
      inactive: eq(products.status, 'inactive'),
      rejected: eq(products.status, 'rejected'),
    };
    const where = and(base, tabs[query.tab ?? 'all'], query.status ? statuses[query.status] : undefined);
    const [total, all, active, inactive, draft] = await Promise.all([
      this.countWhere(where),
      this.countWhere(base),
      this.countWhere(and(base, tabs.active)),
      this.countWhere(and(base, tabs.inactive)),
      this.countWhere(and(base, tabs.draft)),
    ]);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.select(where, [desc(products.createdAt), desc(products.id)], window.size, window.skip);
    const names = await this.categories.names();
    return {
      ...toPage(
        rows.map((row) => toSellerProduct(row, names)),
        total,
        window,
      ),
      counts: { all, active, inactive, draft },
    };
  }

  async sellerGet(seller: AuthUser, id: string): Promise<SellerProductView> {
    return toSellerProduct(await this.ownProduct(seller, id), await this.categories.names());
  }

  async create(seller: AuthUser, input: CreateProductDto): Promise<SellerProductView> {
    const record = await this.sellerRecord(seller);
    await this.assertListable(input);
    const images = input.images ?? [];
    const videos = input.videos ?? [];
    await this.media.assertOwnedUrls([...images, ...videos], { id: seller.id, type: 'user' }, ['product']);
    if (input.publish) {
      if (!seller.emailVerified) throw Errors.forbidden('Verify your email address before publishing.', 'EMAIL_NOT_VERIFIED');
      if (!images.length) throw Errors.badRequest('Add at least one photo before publishing.', 'IMAGES_REQUIRED');
      await this.assertUnderListingLimit(record);
    }

    const decision = input.publish ? await this.moderationDecision(record, input) : { status: 'draft' as ListingStatus, flags: [] };
    const [row] = await this.db
      .insert(products)
      .values({
        sellerId: seller.id,
        title: input.title,
        description: input.description,
        summary: excerpt(input.description, 120),
        highlights: input.highlights ?? [],
        categoryId: input.categoryId,
        brand: input.brand ?? null,
        condition: input.condition,
        price: input.price,
        pricing: input.pricing,
        paymentMethod: input.paymentMethod,
        delivery: input.delivery,
        stock: input.stock,
        location: input.location ?? record.location ?? 'Lagos',
        images,
        videos: await this.videoEntries(videos),
        status: decision.status,
        moderationFlags: decision.flags,
        sellerVerified: record.identity === 'verified',
        listedAs: 'seller',
        publishedAt: decision.status === 'active' ? new Date() : null,
      })
      .returning(productColumns);
    const product = toProduct(row);
    await this.afterChange(product);
    this.flagIfSuspicious(product);
    return toSellerProduct(product, await this.categories.names());
  }

  private async videoEntries(urls: string[]): Promise<{ url: string; posterUrl?: string }[]> {
    return Promise.all(
      urls.map(async (url) => {
        const media = await this.media.byUrl(url);
        return { url, ...(media?.posterUrl ? { posterUrl: media.posterUrl } : {}) };
      }),
    );
  }

  async update(seller: AuthUser, id: string, input: UpdateProductDto): Promise<SellerProductView> {
    const product = await this.ownProduct(seller, id);
    await this.assertListable({ categoryId: input.categoryId, paymentMethod: input.paymentMethod });
    const keepVideos = product.videos.map((video) => video.url);
    await this.media.assertOwnedUrls([...(input.images ?? []), ...(input.videos ?? [])], { id: seller.id, type: 'user' }, ['product'], [...product.images, ...keepVideos]);

    const set: ProductPatch = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.description !== undefined) {
      set.description = input.description;
      set.summary = excerpt(input.description, 120);
    }
    if (input.highlights !== undefined) set.highlights = input.highlights;
    if (input.categoryId !== undefined) set.categoryId = input.categoryId;
    if (input.brand !== undefined) set.brand = input.brand;
    if (input.condition !== undefined) set.condition = input.condition;
    if (input.pricing !== undefined) set.pricing = input.pricing;
    if (input.paymentMethod !== undefined) set.paymentMethod = input.paymentMethod;
    if (input.delivery !== undefined) set.delivery = input.delivery;
    if (input.stock !== undefined) set.stock = input.stock;
    if (input.location !== undefined) set.location = input.location;
    if (input.images !== undefined) set.images = input.images;
    if (input.videos !== undefined) set.videos = await this.videoEntries(input.videos);
    const priceChanged = input.price !== undefined && input.price !== product.price;
    if (priceChanged) {
      set.price = input.price;
      set.previousPrice = product.price;
      set.previousPriceSince = product.priceChangedAt ?? product.publishedAt ?? product.createdAt;
      set.priceChangedAt = new Date();
    }

    // A live listing whose price or category changed is re-checked; a rejected or flagged one is resubmitted.
    const material = priceChanged || input.categoryId !== undefined;
    const resubmit = ['rejected', 'suspicious'].includes(product.status) || (product.status === 'active' && material) || (product.status === 'pending' && material);
    if (resubmit) {
      const record = await this.sellerRecord(seller);
      const decision = await this.moderationDecision(record, {
        categoryId: input.categoryId ?? product.categoryId,
        price: priceChanged ? input.price! : product.price,
      });
      set.status = decision.status;
      set.moderationFlags = decision.flags;
      set.moderationNote = null;
      if (decision.status === 'active' && !product.publishedAt) set.publishedAt = new Date();
    }

    const updated = (await this.patch(product.id, set))!;
    await this.afterChange(updated);
    if (updated.categoryId !== product.categoryId) await this.cache.delete(medianKey(product.categoryId));
    this.flagIfSuspicious(updated);
    if (product.stock <= 0 && updated.stock > 0 && updated.status === 'active') {
      this.events.publish<ProductRestocked>(PRODUCT_EVENTS.restocked, { productId: product.id, title: updated.title });
    }
    if (updated.status !== product.status) {
      this.events.publish<ProductStatusChanged>(PRODUCT_EVENTS.statusChanged, {
        productId: product.id,
        sellerId: seller.id,
        title: updated.title,
        from: product.status,
        to: updated.status,
        by: 'system',
      });
    }
    return toSellerProduct(updated, await this.categories.names());
  }

  /** Publish (active), unpublish (inactive) or move back to draft. */
  async setSellerStatus(seller: AuthUser, id: string, status: 'active' | 'draft' | 'inactive'): Promise<SellerProductView> {
    const product = await this.ownProduct(seller, id);
    let next: ListingStatus = status;
    let flags = product.moderation.flags;
    if (status === 'active') {
      if (['active', 'pending', 'suspicious'].includes(product.status)) return toSellerProduct(product, await this.categories.names());
      if (!seller.emailVerified) throw Errors.forbidden('Verify your email address before publishing.', 'EMAIL_NOT_VERIFIED');
      if (!product.images.length) throw Errors.badRequest('Add at least one photo before publishing.', 'IMAGES_REQUIRED');
      await this.assertListable({ categoryId: product.categoryId, paymentMethod: product.paymentMethod });
      const record = await this.sellerRecord(seller);
      await this.assertUnderListingLimit(record, product.id);
      const decision = await this.moderationDecision(record, product);
      next = decision.status;
      flags = decision.flags;
    }
    if (status === 'inactive' && product.status === 'draft') {
      throw Errors.conflict('A draft is not live; publish it or keep it as a draft.', 'INVALID_STATUS_CHANGE');
    }
    const updated = (await this.patch(product.id, {
      status: next,
      moderationFlags: flags,
      ...(next === 'active' && !product.publishedAt ? { publishedAt: new Date() } : {}),
    }))!;
    await this.afterChange(updated);
    this.flagIfSuspicious(updated);
    return toSellerProduct(updated, await this.categories.names());
  }

  async remove(seller: AuthUser, id: string): Promise<{ deleted: true }> {
    const product = await this.ownProduct(seller, id);
    await this.patch(product.id, { deletedAt: new Date(), status: 'inactive' });
    await this.afterChange(product);
    return { deleted: true };
  }

  /* --- Console ------------------------------------------------------------------- */

  async adminList(query: {
    search?: string;
    page?: number;
    limit?: number;
    statuses?: ListingStatus[];
    categories?: string[];
    minPrice?: number;
    maxPrice?: number;
    minStock?: number;
    maxStock?: number;
    sellerId?: string;
  }): Promise<Page<AdminListingView>> {
    const search = query.search?.trim();
    const where = and(
      isNull(products.deletedAt),
      query.statuses?.length ? inArray(products.status, query.statuses) : undefined,
      query.categories?.length ? inArray(products.categoryId, query.categories) : undefined,
      query.sellerId && isUuid(query.sellerId) ? eq(products.sellerId, query.sellerId) : undefined,
      query.minPrice !== undefined ? gte(products.price, query.minPrice) : undefined,
      query.maxPrice !== undefined ? lte(products.price, query.maxPrice) : undefined,
      query.minStock !== undefined ? gte(products.stock, query.minStock) : undefined,
      query.maxStock !== undefined ? lte(products.stock, query.maxStock) : undefined,
      search
        ? or(
            containsText(products.title, search),
            inArray(
              products.sellerId,
              this.db
                .select({ id: users.id })
                .from(users)
                .where(or(containsText(users.firstName, search), containsText(users.lastName, search), containsText(users.email, search), containsText(users.sellerStoreName, search))),
            ),
          )
        : undefined,
    );
    const total = await this.countWhere(where);
    const window = pageWindow(total, query.page, query.limit ?? 7);
    const rows = await this.select(where, [desc(products.createdAt), desc(products.id)], window.size, window.skip);
    return toPage(await this.adminViews(rows), total, window);
  }

  private async adminViews(rows: Product[]): Promise<AdminListingView[]> {
    const [sellers, names] = await Promise.all([this.users.findByIds(rows.map((row) => row.sellerId)), this.categories.names()]);
    const byId = new Map(sellers.map((seller) => [seller.id, seller]));
    return rows.map((row) => toAdminListing(row, byId.get(row.sellerId) ?? null, names));
  }

  async adminGet(id: string): Promise<AdminListingView> {
    const product = await this.findById(id);
    if (!product) throw Errors.notFound('That item is no longer listed.', 'PRODUCT_NOT_FOUND');
    return (await this.adminViews([product]))[0];
  }

  /** Approve, flag, deactivate or reject a listing from the console. */
  async moderate(staff: AuthStaff, id: string, status: ListingStatus, note?: string): Promise<AdminListingView> {
    const product = await this.findById(id);
    if (!product) throw Errors.notFound('That item is no longer listed.', 'PRODUCT_NOT_FOUND');
    if (status === 'draft') throw Errors.badRequest('Only the seller can move a listing back to draft.', 'INVALID_STATUS_CHANGE');
    if (status === 'active' && !product.images.length) throw Errors.badRequest('A listing needs at least one photo to go live.', 'IMAGES_REQUIRED');
    const updated = (await this.patch(id, {
      status,
      moderationNote: note ?? null,
      moderationReviewedBy: staff.id,
      moderationReviewedAt: new Date(),
      ...(status === 'active' ? { moderationFlags: [] } : {}),
      ...(status === 'active' && !product.publishedAt ? { publishedAt: new Date() } : {}),
    }))!;
    await this.afterChange(updated);
    const verb: Record<string, string> = {
      active: 'Approved a listing',
      suspicious: 'Flagged a listing for review',
      inactive: 'Deactivated a listing',
      rejected: 'Rejected a listing',
      pending: 'Returned a listing to review',
    };
    await this.audit.record(staff, { action: verb[status] ?? 'Updated a listing', target: product.title, targetType: 'listing', targetId: id, meta: { from: product.status, to: status, note } });
    if (product.status !== status) {
      this.events.publish<ProductStatusChanged>(PRODUCT_EVENTS.statusChanged, {
        productId: id,
        sellerId: product.sellerId,
        title: product.title,
        from: product.status,
        to: status,
        note,
        by: 'staff',
      });
    }
    return (await this.adminViews([updated]))[0];
  }

  async setFeatured(staff: AuthStaff, id: string, featured: boolean): Promise<AdminListingView> {
    const updated = isUuid(id) ? await this.patch(id, { featured }, isNull(products.deletedAt)) : null;
    if (!updated) throw Errors.notFound('That item is no longer listed.', 'PRODUCT_NOT_FOUND');
    await this.cache.delete(HOME_KEY);
    await this.audit.record(staff, { action: featured ? 'Featured a listing' : 'Removed a listing from Featured', target: updated.title, targetType: 'listing', targetId: id });
    return (await this.adminViews([updated]))[0];
  }

  async adminRemove(staff: AuthStaff, id: string): Promise<{ id: string }> {
    const product = await this.findById(id);
    if (!product) throw Errors.notFound('That item is no longer listed.', 'PRODUCT_NOT_FOUND');
    await this.patch(id, { deletedAt: new Date(), status: 'inactive', moderationReviewedBy: staff.id, moderationReviewedAt: new Date() });
    await this.afterChange(product);
    await this.audit.record(staff, { action: 'Deleted a listing', target: product.title, targetType: 'listing', targetId: id });
    return { id };
  }

  /** The console's own store, which official and admin listings are published under. */
  async officialStore(): Promise<User> {
    const existing = await this.users.findByEmail(OFFICIAL_STORE_EMAIL);
    if (existing) return existing;
    try {
      await this.db.insert(users).values({
        firstName: 'DOOAA',
        lastName: 'Official Store',
        email: OFFICIAL_STORE_EMAIL,
        phone: '',
        // Not a usable password: the store account never signs in.
        passwordHash: '!disabled',
        role: 'seller',
        emailVerified: true,
        identity: 'verified',
        verificationLevel: 'high-value',
        location: 'Lagos',
        region: 'Lagos',
        sellerStoreName: 'DOOAA Official Store',
        sellerDispatchDays: 2,
        sellerResponseLabel: 'Typically responds within an hour',
        sellerDeliveryLabel: 'Nationwide Delivery (1-3 business days within Lagos)',
      });
    } catch (error) {
      if (!isUniqueViolation(error, 'users_email_key')) throw error;
    }
    return (await this.users.findByEmail(OFFICIAL_STORE_EMAIL))!;
  }

  /** "Add New Product" in the console. Staff listings skip the seller moderation queue. */
  async adminCreate(
    staff: AuthStaff,
    input: Omit<CreateProductDto, 'condition'> & { condition?: CreateProductDto['condition']; status?: 'active' | 'pending' | 'inactive' | 'draft'; listedAs?: 'official' | 'admin' },
  ): Promise<AdminListingView> {
    await this.assertListable(input);
    const images = input.images ?? [];
    const videos = input.videos ?? [];
    await this.media.assertOwnedUrls([...images, ...videos], { id: staff.id, type: 'staff' }, ['product']);
    const status = input.status ?? 'active';
    if ((status === 'active' || status === 'pending') && !images.length) throw Errors.badRequest('Add at least one photo before publishing.', 'IMAGES_REQUIRED');
    const store = await this.officialStore();
    const now = new Date();
    const [row] = await this.db
      .insert(products)
      .values({
        sellerId: store.id,
        title: input.title,
        description: input.description,
        summary: excerpt(input.description, 120),
        highlights: input.highlights ?? [],
        categoryId: input.categoryId,
        brand: input.brand ?? null,
        condition: input.condition ?? 'new',
        price: input.price,
        pricing: input.pricing,
        paymentMethod: input.paymentMethod,
        delivery: input.delivery,
        stock: input.stock,
        location: input.location ?? 'Lagos',
        images,
        videos: await this.videoEntries(videos),
        status,
        listedAs: input.listedAs ?? 'official',
        sellerVerified: true,
        moderationFlags: [],
        moderationReviewedBy: staff.id,
        moderationReviewedAt: now,
        publishedAt: status === 'active' ? now : null,
      })
      .returning(productColumns);
    const product = toProduct(row);
    await this.afterChange(product);
    await this.audit.record(staff, { action: 'Created a listing', target: product.title, targetType: 'listing', targetId: product.id });
    return (await this.adminViews([product]))[0];
  }

  /* --- Hooks used by other modules ---------------------------------------------- */

  /**
   * Holds stock for a checkout, in one conditional statement. Null when there
   * is not enough (or the listing went away). Pass the checkout's transaction
   * so a failed checkout gives the stock back on rollback.
   */
  async reserveStock(productId: string, quantity: number, executor: Executor = this.db): Promise<Product | null> {
    const [row] = await executor
      .update(products)
      .set({ stock: sql`${products.stock} - ${quantity}` })
      .where(and(eq(products.id, productId), eq(products.status, 'active'), isNull(products.deletedAt), gte(products.stock, quantity)))
      .returning(productColumns);
    if (row && row.stock === 0) await this.cache.delete(HOME_KEY);
    return row ? toProduct(row) : null;
  }

  async releaseStock(productId: string, quantity: number): Promise<void> {
    const [row] = await this.db
      .update(products)
      .set({ stock: sql`${products.stock} + ${quantity}` })
      .where(eq(products.id, productId))
      .returning({ id: products.id, title: products.title, stock: products.stock, status: products.status, deletedAt: products.deletedAt });
    // Back from nothing: anyone waiting on a restock hears about it.
    if (row && row.stock - quantity <= 0 && row.status === 'active' && !row.deletedAt) {
      this.events.publish<ProductRestocked>(PRODUCT_EVENTS.restocked, { productId: row.id, title: row.title });
    }
  }

  async recordSale(productId: string, quantity: number, revenue: number, at: Date): Promise<void> {
    await this.db
      .update(products)
      .set({
        statsUnitsSold: sql`${products.statsUnitsSold} + ${quantity}`,
        statsRevenue: sql`${products.statsRevenue} + ${revenue}`,
        statsLastSaleAt: sql`greatest(${products.statsLastSaleAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(products.id, productId));
    await this.cache.delete(HOME_KEY);
  }

  async reverseSale(productId: string, quantity: number, revenue: number): Promise<void> {
    await this.db
      .update(products)
      .set({ statsUnitsSold: sql`${products.statsUnitsSold} - ${quantity}`, statsRevenue: sql`${products.statsRevenue} - ${revenue}` })
      .where(eq(products.id, productId));
  }

  async incrementInquiries(productId: string): Promise<void> {
    await this.db
      .update(products)
      .set({ statsInquiries: sql`${products.statsInquiries} + 1` })
      .where(eq(products.id, productId));
  }

  async setRating(productId: string, average: number, total: number): Promise<void> {
    await this.db.update(products).set({ statsRatingAverage: average, statsRatingCount: total }).where(eq(products.id, productId));
  }

  async adjustWishlistCount(productId: string, delta: number): Promise<void> {
    await this.db
      .update(products)
      .set({ statsWishlists: sql`${products.statsWishlists} + ${delta}` })
      .where(eq(products.id, productId));
  }

  /** Keeps the "Verified sellers" facet true to the seller's identity check. */
  async syncSellerVerified(sellerId: string, verified: boolean): Promise<void> {
    await this.db.update(products).set({ sellerVerified: verified }).where(eq(products.sellerId, sellerId));
    await this.cache.delete(HOME_KEY);
  }

  /** Takes a banned or suspended seller's listings off the storefront, remembering which to bring back. */
  async restrictSeller(sellerId: string): Promise<number> {
    const changed = await this.db
      .update(products)
      .set({ status: 'inactive', moderationFlags: sql`array_append(array_remove(${products.moderationFlags}, 'seller-restricted'), 'seller-restricted')` })
      .where(and(eq(products.sellerId, sellerId), eq(products.status, 'active'), isNull(products.deletedAt)))
      .returning({ id: products.id });
    await Promise.all([this.categories.invalidateCounts(), this.cache.delete(HOME_KEY)]);
    await this.recountActiveListings(sellerId);
    return changed.length;
  }

  async unrestrictSeller(sellerId: string): Promise<number> {
    const changed = await this.db
      .update(products)
      .set({ status: 'active', moderationFlags: sql`array_remove(${products.moderationFlags}, 'seller-restricted')` })
      .where(
        and(
          eq(products.sellerId, sellerId),
          eq(products.status, 'inactive'),
          sql`'seller-restricted' = any(${products.moderationFlags})`,
          isNull(products.deletedAt),
        ),
      )
      .returning({ id: products.id });
    await Promise.all([this.categories.invalidateCounts(), this.cache.delete(HOME_KEY)]);
    await this.recountActiveListings(sellerId);
    return changed.length;
  }
}
