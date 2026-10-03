import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import type { ListingStatus } from '../../common/domain';
import { TtlCache } from '../../common/util/cache';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { containsRegex, excerpt } from '../../common/util/text';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { MediaService } from '../media/media.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/schemas/user.schema';
import { WishlistItem } from '../wishlist/wishlist.schema';
import type { CreateProductDto, SellerStatusFilter, UpdateProductDto } from './dto/product.dto';
import { PUBLIC_PRODUCT_FILTER, buildCatalogFilter, catalogSort, type CatalogQuery } from './product.filters';
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
import { Product } from './schemas/product.schema';

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

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const MIN_LISTINGS_FOR_OUTLIER = 5;

type Viewer = { id: string } | undefined;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private readonly medians = new TtlCache<number | null>(5 * 60_000);
  private readonly home = new TtlCache<{ topSellers: Lean<Product>[]; featured: Lean<Product>[]; popular: Lean<Product>[] }>(60_000, 1);

  constructor(
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(WishlistItem.name) private readonly wishlist: Model<WishlistItem>,
    private readonly categories: CategoriesService,
    private readonly settings: SettingsService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  get model(): Model<Product> {
    return this.products;
  }

  /* --- Lookups ----------------------------------------------------------------- */

  async findById(id: string | Types.ObjectId): Promise<Lean<Product> | null> {
    if (!Types.ObjectId.isValid(String(id))) return null;
    return this.products.findOne({ _id: id, deletedAt: null }).lean<Lean<Product>>();
  }

  async findPublic(id: string): Promise<Lean<Product>> {
    if (!Types.ObjectId.isValid(id)) throw Errors.notFound('This item is no longer listed.', 'PRODUCT_NOT_FOUND');
    const product = await this.products.findOne({ _id: id, ...PUBLIC_PRODUCT_FILTER }).lean<Lean<Product>>();
    if (!product) throw Errors.notFound('This item is no longer listed.', 'PRODUCT_NOT_FOUND');
    return product;
  }

  private async wishlistedSet(viewer: Viewer, ids: Types.ObjectId[]): Promise<Set<string>> {
    if (!viewer || !ids.length) return new Set();
    const rows = await this.wishlist.find({ userId: new Types.ObjectId(viewer.id), productId: { $in: ids } }).select('productId').lean();
    return new Set(rows.map((row) => String(row.productId)));
  }

  async toCards(products: Lean<Product>[], viewer?: Viewer): Promise<ProductCard[]> {
    const [categoryNames, wishlisted] = await Promise.all([
      this.categories.names(),
      this.wishlistedSet(viewer, products.map((product) => product._id)),
    ]);
    return products.map((product) => toProductCard(product, { categoryNames, wishlisted }));
  }

  /** Cards for a list of ids, in the order given; ids that no longer resolve are dropped. */
  async cardsByIds(ids: (string | Types.ObjectId)[], viewer?: Viewer, includeUnavailable = false): Promise<ProductCard[]> {
    const objectIds = ids.filter((id) => Types.ObjectId.isValid(String(id))).map((id) => new Types.ObjectId(String(id)));
    const filter: Record<string, unknown> = { _id: { $in: objectIds }, deletedAt: null };
    if (!includeUnavailable) filter.status = 'active';
    const rows = await this.products.find(filter).lean<Lean<Product>[]>();
    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const ordered = objectIds.map((id) => byId.get(String(id))).filter((row): row is Lean<Product> => Boolean(row));
    return this.toCards(ordered, viewer);
  }

  /* --- Storefront -------------------------------------------------------------- */

  async search(query: CatalogQuery & { page?: number; limit?: number }, viewer?: Viewer): Promise<Page<ProductCard> & { facets: CatalogFacets }> {
    const size = query.limit ?? 24;
    let mode: 'text' | 'regex' | 'none' = query.q?.trim() ? 'text' : 'none';
    let filter = buildCatalogFilter(query, mode);
    let total = await this.products.countDocuments(filter).catch((error: { code?: number }) => {
      // No text index (e.g. a fresh database mid-build): search by substring instead of failing.
      if (error?.code === 27) return -1;
      throw error;
    });
    if (total === -1) {
      mode = 'regex';
      filter = buildCatalogFilter(query, mode);
      total = await this.products.countDocuments(filter);
    }
    if (total === 0 && mode === 'text') {
      // Full-text matches whole words only; fall back to a substring match for partial words.
      mode = 'regex';
      filter = buildCatalogFilter(query, mode);
      total = await this.products.countDocuments(filter);
    }
    const window = pageWindow(total, query.page, size);
    const projection = mode === 'text' ? { score: { $meta: 'textScore' } } : {};
    const [rows, facets] = await Promise.all([
      this.products
        .find(filter, projection)
        .sort(catalogSort(query, mode) as never)
        .skip(window.skip)
        .limit(window.size)
        .lean<Lean<Product>[]>(),
      this.facets(buildCatalogFilter({ q: query.q, category: query.category, price: query.price, min: query.min, max: query.max, collection: query.collection }, mode)),
    ]);
    return { ...toPage(await this.toCards(rows, viewer), total, window), facets };
  }

  private async facets(filter: QueryFilter<Product>): Promise<CatalogFacets> {
    const [result] = await this.products.aggregate<{
      brands: { _id: string; count: number }[];
      conditions: { _id: string; count: number }[];
      sellers: { _id: boolean; count: number }[];
      price: { min: number; max: number }[];
    }>([
      { $match: filter },
      {
        $facet: {
          brands: [{ $match: { brand: { $nin: [null, ''] } } }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 20 }],
          conditions: [{ $group: { _id: '$condition', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
          sellers: [{ $group: { _id: '$sellerVerified', count: { $sum: 1 } } }],
          price: [{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }],
        },
      },
    ]);
    return {
      brands: (result?.brands ?? []).map((row) => ({ value: row._id, count: row.count })),
      conditions: (result?.conditions ?? []).map((row) => ({ value: row._id, count: row.count })),
      sellers: {
        verified: result?.sellers.find((row) => row._id === true)?.count ?? 0,
        unverified: result?.sellers.find((row) => row._id !== true)?.count ?? 0,
      },
      price: { min: result?.price[0]?.min ?? 0, max: result?.price[0]?.max ?? 0 },
    };
  }

  /** Header search-as-you-type: prefix matches on titles and brands. */
  async suggest(q: string): Promise<{ id: string; title: string; categoryId: string; image: string | null }[]> {
    const pattern = new RegExp(`(^|\\s)${q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const rows = await this.products
      .find({ ...PUBLIC_PRODUCT_FILTER, $or: [{ title: pattern }, { brand: pattern }] })
      .sort({ 'stats.views': -1, _id: -1 })
      .limit(8)
      .select('title categoryId images')
      .lean<Lean<Product>[]>();
    return rows.map((row) => ({ id: String(row._id), title: row.title, categoryId: row.categoryId, image: row.images[0] ?? null }));
  }

  /** The landing page: category tiles and the three rails. */
  async homepage(viewer?: Viewer) {
    const rails = await this.home.wrap('home', async () => {
      const base = { ...PUBLIC_PRODUCT_FILTER, stock: { $gt: 0 } };
      const [topSellers, featuredFlagged, popular] = await Promise.all([
        this.products.find(base).sort({ 'stats.unitsSold': -1, 'stats.ratingAverage': -1, publishedAt: -1 }).limit(8).lean<Lean<Product>[]>(),
        this.products.find({ ...base, featured: true }).sort({ publishedAt: -1 }).limit(8).lean<Lean<Product>[]>(),
        this.products.find(base).sort({ 'stats.views': -1, 'stats.wishlists': -1, publishedAt: -1 }).limit(8).lean<Lean<Product>[]>(),
      ]);
      // Until enough listings are curated, the Featured rail tops up with the newest verified ones.
      let featured = featuredFlagged;
      if (featured.length < 8) {
        const extra = await this.products
          .find({ ...base, sellerVerified: true, _id: { $nin: featured.map((row) => row._id) } })
          .sort({ publishedAt: -1, createdAt: -1 })
          .limit(8 - featured.length)
          .lean<Lean<Product>[]>();
        featured = [...featured, ...extra];
      }
      return { topSellers, featured, popular };
    });
    const [categories, topSellers, featured, popular] = await Promise.all([
      this.categories.homeTiles(),
      this.toCards(rails.topSellers, viewer),
      this.toCards(rails.featured, viewer),
      this.toCards(rails.popular, viewer),
    ]);
    return { categories, topSellers, featured, popular };
  }

  async detail(id: string, viewer?: Viewer): Promise<ProductDetail & { alsoViewed: ProductCard[] }> {
    const product = await this.findPublic(id);
    const [seller, categoryNames, wishlisted, related] = await Promise.all([
      this.users.findById(product.sellerId).lean<Lean<User>>(),
      this.categories.names(),
      this.wishlistedSet(viewer, [product._id]),
      this.products
        .find({ ...PUBLIC_PRODUCT_FILTER, categoryId: product.categoryId, _id: { $ne: product._id } })
        .sort({ 'stats.views': -1, publishedAt: -1 })
        .limit(3)
        .lean<Lean<Product>[]>(),
    ]);
    if (!viewer || viewer.id !== String(product.sellerId)) {
      void this.products.updateOne({ _id: product._id }, { $inc: { 'stats.views': 1 } }).catch(() => undefined);
      this.events.publish<ProductViewed>(PRODUCT_EVENTS.viewed, { productId: String(product._id), sellerId: String(product.sellerId) });
    }
    return {
      ...toProductDetail(product, seller, { categoryNames, wishlisted }),
      alsoViewed: await this.toCards(related, viewer),
    };
  }

  /** A seller's public storefront listings. */
  async bySeller(sellerId: string, page = 1, limit = 24, viewer?: Viewer): Promise<Page<ProductCard>> {
    if (!Types.ObjectId.isValid(sellerId)) throw Errors.notFound('That seller is not on DOOAA.', 'SELLER_NOT_FOUND');
    const filter = { ...PUBLIC_PRODUCT_FILTER, sellerId: new Types.ObjectId(sellerId) };
    const total = await this.products.countDocuments(filter);
    const window = pageWindow(total, page, limit);
    const rows = await this.products.find(filter).sort({ publishedAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Product>[]>();
    return toPage(await this.toCards(rows, viewer), total, window);
  }

  /* --- Moderation ------------------------------------------------------------ */

  /** Median live price in a category, for the "Suspicious" price check. Null when there are too few listings to judge. */
  private categoryMedian(categoryId: string): Promise<number | null> {
    return this.medians.wrap(categoryId, async () => {
      const filter = { ...PUBLIC_PRODUCT_FILTER, categoryId };
      const count = await this.products.countDocuments(filter);
      if (count < MIN_LISTINGS_FOR_OUTLIER) return null;
      const [middle] = await this.products.find(filter).sort({ price: 1 }).skip(Math.floor(count / 2)).limit(1).select('price').lean();
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

  async recountActiveListings(sellerId: string | Types.ObjectId): Promise<void> {
    const count = await this.products.countDocuments({ sellerId: new Types.ObjectId(String(sellerId)), status: 'active', deletedAt: null });
    await this.users.updateOne({ _id: sellerId }, { $set: { 'stats.activeListings': count } });
  }

  private afterChange(product: Pick<Product, 'categoryId'> & { sellerId: Types.ObjectId }): void {
    this.categories.invalidateCounts();
    this.home.clear();
    this.medians.delete(product.categoryId);
    void this.recountActiveListings(product.sellerId).catch(() => undefined);
  }

  private flagIfSuspicious(product: Lean<Product>): void {
    if (product.status === 'suspicious') {
      this.events.publish<ProductFlagged>(PRODUCT_EVENTS.flagged, {
        productId: String(product._id),
        title: product.title,
        reasons: product.moderation?.flags ?? [],
        price: product.price,
      });
    }
  }

  /* --- Seller tools ------------------------------------------------------------ */

  private async sellerRecord(seller: AuthUser): Promise<Lean<User>> {
    const record = await this.users.findById(seller.id).lean<Lean<User>>();
    if (!record) throw Errors.unauthorized();
    return record;
  }

  /** The console can cap how many listings a seller has live or in review at once. */
  private async assertUnderListingLimit(record: Lean<User>, excludeId?: Types.ObjectId): Promise<void> {
    const limit = record.seller?.listingLimit;
    if (limit === null || limit === undefined) return;
    const live = await this.products.countDocuments({
      sellerId: record._id,
      deletedAt: null,
      status: { $in: ['active', 'pending', 'suspicious'] },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (live >= limit) {
      throw Errors.forbidden(
        limit === 0
          ? 'Your account cannot publish listings right now. Contact support for details.'
          : `You can have up to ${limit} live listing${limit === 1 ? '' : 's'} at a time. Unpublish one or contact support to raise the limit.`,
        'LISTING_LIMIT_REACHED',
      );
    }
  }

  private async ownProduct(seller: AuthUser, id: string): Promise<Lean<Product>> {
    if (!Types.ObjectId.isValid(id)) throw Errors.notFound('That product is not in your store.', 'PRODUCT_NOT_FOUND');
    const product = await this.products.findOne({ _id: id, sellerId: new Types.ObjectId(seller.id), deletedAt: null }).lean<Lean<Product>>();
    if (!product) throw Errors.notFound('That product is not in your store.', 'PRODUCT_NOT_FOUND');
    return product;
  }

  async sellerList(
    seller: AuthUser,
    query: { tab?: 'all' | 'active' | 'inactive' | 'draft'; q?: string; status?: SellerStatusFilter; page?: number; limit?: number },
  ): Promise<Page<SellerProductView> & { counts: SellerTabCounts }> {
    const base: Record<string, unknown> = { sellerId: new Types.ObjectId(seller.id), deletedAt: null };
    if (query.q?.trim()) base.title = containsRegex(query.q);
    const tabs: Record<string, Record<string, unknown>> = {
      all: {},
      active: { status: 'active', stock: { $gt: 0 } },
      // "Inactive Products" gathers everything a buyer cannot purchase right now.
      inactive: { $or: [{ status: { $in: ['pending', 'inactive', 'suspicious', 'rejected'] } }, { status: 'active', stock: { $lte: 0 } }] },
      draft: { status: 'draft' },
    };
    // The pill a listing shows: flagged listings wait on review like new ones.
    const statuses: Record<SellerStatusFilter, Record<string, unknown>> = {
      active: { status: 'active', stock: { $gt: 0 } },
      'out-of-stock': { status: 'active', stock: { $lte: 0 } },
      pending: { status: { $in: ['pending', 'suspicious'] } },
      draft: { status: 'draft' },
      inactive: { status: 'inactive' },
      rejected: { status: 'rejected' },
    };
    const filter = query.status
      ? { ...base, $and: [tabs[query.tab ?? 'all'], statuses[query.status]] }
      : { ...base, ...tabs[query.tab ?? 'all'] };
    const [total, all, active, inactive, draft] = await Promise.all([
      this.products.countDocuments(filter),
      this.products.countDocuments({ ...base }),
      this.products.countDocuments({ ...base, ...tabs.active }),
      this.products.countDocuments({ ...base, ...tabs.inactive }),
      this.products.countDocuments({ ...base, ...tabs.draft }),
    ]);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.products.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Product>[]>();
    const names = await this.categories.names();
    return { ...toPage(rows.map((row) => toSellerProduct(row, names)), total, window), counts: { all, active, inactive, draft } };
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
    const now = new Date();
    const created = await this.products.create({
      sellerId: new Types.ObjectId(seller.id),
      title: input.title,
      description: input.description,
      summary: excerpt(input.description, 120),
      highlights: input.highlights ?? [],
      categoryId: input.categoryId,
      brand: input.brand,
      condition: input.condition,
      price: input.price,
      pricing: input.pricing,
      paymentMethod: input.paymentMethod,
      delivery: input.delivery,
      stock: input.stock,
      location: input.location ?? (record.location ? `${record.location}` : 'Lagos'),
      images,
      videos: await this.videoEntries(videos),
      status: decision.status,
      moderation: { flags: decision.flags },
      sellerVerified: record.identity === 'verified',
      listedAs: 'seller',
      publishedAt: decision.status === 'active' ? now : undefined,
    });
    const product = created.toObject() as Lean<Product>;
    this.afterChange(product);
    this.flagIfSuspicious(product);
    return toSellerProduct(product, await this.categories.names());
  }

  private async videoEntries(urls: string[]): Promise<{ url: string; posterUrl?: string }[]> {
    return Promise.all(
      urls.map(async (url) => {
        const media = await this.media.byUrl(url);
        return { url, posterUrl: media?.posterUrl };
      }),
    );
  }

  async update(seller: AuthUser, id: string, input: UpdateProductDto): Promise<SellerProductView> {
    const product = await this.ownProduct(seller, id);
    await this.assertListable({ categoryId: input.categoryId, paymentMethod: input.paymentMethod });
    const keepImages = product.images;
    const keepVideos = product.videos.map((video) => video.url);
    await this.media.assertOwnedUrls([...(input.images ?? []), ...(input.videos ?? [])], { id: seller.id, type: 'user' }, ['product'], [...keepImages, ...keepVideos]);

    const set: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'highlights', 'categoryId', 'brand', 'condition', 'pricing', 'paymentMethod', 'delivery', 'stock', 'location', 'images'] as const) {
      if (input[key] !== undefined) set[key] = input[key];
    }
    if (input.description !== undefined) set.summary = excerpt(input.description, 120);
    if (input.videos !== undefined) set.videos = await this.videoEntries(input.videos);
    if (input.price !== undefined && input.price !== product.price) {
      set.price = input.price;
      set.previousPrice = product.price;
      set.previousPriceSince = product.priceChangedAt ?? product.publishedAt ?? product.createdAt;
      set.priceChangedAt = new Date();
    }

    // A live listing whose price or category changed is re-checked; a rejected or flagged one is resubmitted.
    const material = set.price !== undefined || set.categoryId !== undefined;
    const resubmit = ['rejected', 'suspicious'].includes(product.status) || (product.status === 'active' && material) || (product.status === 'pending' && material);
    if (resubmit) {
      const record = await this.sellerRecord(seller);
      const decision = await this.moderationDecision(record, {
        categoryId: (set.categoryId as string) ?? product.categoryId,
        price: (set.price as number) ?? product.price,
      });
      set.status = decision.status;
      set['moderation.flags'] = decision.flags;
      set['moderation.note'] = undefined;
      if (decision.status === 'active' && !product.publishedAt) set.publishedAt = new Date();
    }

    const updated = await this.products.findByIdAndUpdate(product._id, { $set: set }, { returnDocument: 'after', runValidators: true }).lean<Lean<Product>>();
    this.afterChange(updated!);
    this.flagIfSuspicious(updated!);
    if (product.stock <= 0 && updated!.stock > 0 && updated!.status === 'active') {
      this.events.publish<ProductRestocked>(PRODUCT_EVENTS.restocked, { productId: String(product._id), title: updated!.title });
    }
    if (set.status && set.status !== product.status) {
      this.events.publish<ProductStatusChanged>(PRODUCT_EVENTS.statusChanged, {
        productId: String(product._id),
        sellerId: seller.id,
        title: updated!.title,
        from: product.status,
        to: updated!.status,
        by: 'system',
      });
    }
    return toSellerProduct(updated!, await this.categories.names());
  }

  /** Publish (active), unpublish (inactive) or move back to draft. */
  async setSellerStatus(seller: AuthUser, id: string, status: 'active' | 'draft' | 'inactive'): Promise<SellerProductView> {
    const product = await this.ownProduct(seller, id);
    let next: ListingStatus = status;
    let flags = product.moderation?.flags ?? [];
    if (status === 'active') {
      if (['active', 'pending', 'suspicious'].includes(product.status)) return toSellerProduct(product, await this.categories.names());
      if (product.status === 'rejected' && product.moderation?.reviewedBy) {
        // A rejected listing goes back to review rather than straight live.
      }
      if (!seller.emailVerified) throw Errors.forbidden('Verify your email address before publishing.', 'EMAIL_NOT_VERIFIED');
      if (!product.images.length) throw Errors.badRequest('Add at least one photo before publishing.', 'IMAGES_REQUIRED');
      await this.assertListable({ categoryId: product.categoryId, paymentMethod: product.paymentMethod });
      const record = await this.sellerRecord(seller);
      await this.assertUnderListingLimit(record, product._id);
      const decision = await this.moderationDecision(record, product);
      next = decision.status;
      flags = decision.flags;
    }
    if (status === 'inactive' && product.status === 'draft') {
      throw Errors.conflict('A draft is not live; publish it or keep it as a draft.', 'INVALID_STATUS_CHANGE');
    }
    const updated = await this.products
      .findByIdAndUpdate(
        product._id,
        { $set: { status: next, 'moderation.flags': flags, ...(next === 'active' && !product.publishedAt ? { publishedAt: new Date() } : {}) } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Product>>();
    this.afterChange(updated!);
    this.flagIfSuspicious(updated!);
    return toSellerProduct(updated!, await this.categories.names());
  }

  async remove(seller: AuthUser, id: string): Promise<{ deleted: true }> {
    const product = await this.ownProduct(seller, id);
    await this.products.updateOne({ _id: product._id }, { $set: { deletedAt: new Date(), status: 'inactive' } });
    this.afterChange(product);
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
    const filter: Record<string, unknown> = { deletedAt: null };
    if (query.statuses?.length) filter.status = { $in: query.statuses };
    if (query.categories?.length) filter.categoryId = { $in: query.categories };
    if (query.sellerId && Types.ObjectId.isValid(query.sellerId)) filter.sellerId = new Types.ObjectId(query.sellerId);
    const price: Record<string, number> = {};
    if (query.minPrice !== undefined) price.$gte = query.minPrice;
    if (query.maxPrice !== undefined) price.$lte = query.maxPrice;
    if (Object.keys(price).length) filter.price = price;
    const stock: Record<string, number> = {};
    if (query.minStock !== undefined) stock.$gte = query.minStock;
    if (query.maxStock !== undefined) stock.$lte = query.maxStock;
    if (Object.keys(stock).length) filter.stock = stock;
    if (query.search?.trim()) {
      const pattern = containsRegex(query.search);
      const sellers = await this.users
        .find({ $or: [{ firstName: pattern }, { lastName: pattern }, { email: pattern }, { 'seller.storeName': pattern }] })
        .select('_id')
        .limit(200)
        .lean();
      filter.$or = [{ title: pattern }, { sellerId: { $in: sellers.map((row) => row._id) } }];
    }
    const total = await this.products.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 7);
    const rows = await this.products.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Product>[]>();
    return toPage(await this.adminViews(rows), total, window);
  }

  private async adminViews(rows: Lean<Product>[]): Promise<AdminListingView[]> {
    const sellerIds = [...new Set(rows.map((row) => String(row.sellerId)))];
    const [sellers, names] = await Promise.all([
      this.users.find({ _id: { $in: sellerIds } }).lean<Lean<User>[]>(),
      this.categories.names(),
    ]);
    const byId = new Map(sellers.map((seller) => [String(seller._id), seller]));
    return rows.map((row) => toAdminListing(row, byId.get(String(row.sellerId)) ?? null, names));
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
    const updated = await this.products
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status,
            'moderation.note': note,
            'moderation.reviewedBy': staff.id,
            'moderation.reviewedAt': new Date(),
            ...(status === 'active' ? { 'moderation.flags': [] } : {}),
            ...(status === 'active' && !product.publishedAt ? { publishedAt: new Date() } : {}),
          },
        },
        { returnDocument: 'after' },
      )
      .lean<Lean<Product>>();
    this.afterChange(updated!);
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
        sellerId: String(product.sellerId),
        title: product.title,
        from: product.status,
        to: status,
        note,
        by: 'staff',
      });
    }
    return (await this.adminViews([updated!]))[0];
  }

  async setFeatured(staff: AuthStaff, id: string, featured: boolean): Promise<AdminListingView> {
    const updated = await this.products.findOneAndUpdate({ _id: id, deletedAt: null }, { $set: { featured } }, { returnDocument: 'after' }).lean<Lean<Product>>();
    if (!updated) throw Errors.notFound('That item is no longer listed.', 'PRODUCT_NOT_FOUND');
    this.home.clear();
    await this.audit.record(staff, { action: featured ? 'Featured a listing' : 'Removed a listing from Featured', target: updated.title, targetType: 'listing', targetId: id });
    return (await this.adminViews([updated]))[0];
  }

  async adminRemove(staff: AuthStaff, id: string): Promise<{ id: string }> {
    const product = await this.findById(id);
    if (!product) throw Errors.notFound('That item is no longer listed.', 'PRODUCT_NOT_FOUND');
    await this.products.updateOne({ _id: id }, { $set: { deletedAt: new Date(), status: 'inactive', 'moderation.reviewedBy': staff.id, 'moderation.reviewedAt': new Date() } });
    this.afterChange(product);
    await this.audit.record(staff, { action: 'Deleted a listing', target: product.title, targetType: 'listing', targetId: id });
    return { id };
  }

  /** The console's own store, which official and admin listings are published under. */
  async officialStore(): Promise<Lean<User>> {
    const existing = await this.users.findOne({ email: OFFICIAL_STORE_EMAIL }).lean<Lean<User>>();
    if (existing) return existing;
    try {
      await this.users.create({
        firstName: 'DOOAA',
        lastName: 'Official Store',
        email: OFFICIAL_STORE_EMAIL,
        phone: '',
        // Not a usable password: the store account never signs in.
        passwordHash: `!disabled-${new Types.ObjectId().toHexString()}`,
        role: 'seller',
        emailVerified: true,
        identity: 'verified',
        verificationLevel: 'high-value',
        location: 'Lagos',
        region: 'Lagos',
        seller: { storeName: 'DOOAA Official Store', dispatchDays: 2, responseLabel: 'Typically responds within an hour', deliveryLabel: 'Nationwide Delivery (1-3 business days within Lagos)' },
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    return (await this.users.findOne({ email: OFFICIAL_STORE_EMAIL }).lean<Lean<User>>())!;
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
    const created = await this.products.create({
      sellerId: store._id,
      title: input.title,
      description: input.description,
      summary: excerpt(input.description, 120),
      highlights: input.highlights ?? [],
      categoryId: input.categoryId,
      brand: input.brand,
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
      moderation: { flags: [], reviewedBy: staff.id, reviewedAt: new Date() },
      publishedAt: status === 'active' ? new Date() : undefined,
    });
    const product = created.toObject() as Lean<Product>;
    this.afterChange(product);
    await this.audit.record(staff, { action: 'Created a listing', target: product.title, targetType: 'listing', targetId: String(product._id) });
    return (await this.adminViews([product]))[0];
  }

  /* --- Hooks used by other modules ---------------------------------------------- */

  /** Holds stock for a checkout. Null when there is not enough (or the listing went away). */
  async reserveStock(productId: Types.ObjectId | string, quantity: number): Promise<Lean<Product> | null> {
    const updated = await this.products
      .findOneAndUpdate(
        { _id: productId, status: 'active', deletedAt: null, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Product>>();
    if (updated && updated.stock === 0) this.home.clear();
    return updated;
  }

  async releaseStock(productId: Types.ObjectId | string, quantity: number): Promise<void> {
    const before = await this.products.findOneAndUpdate({ _id: productId }, { $inc: { stock: quantity } }, { returnDocument: 'before' }).lean<Lean<Product>>();
    if (before && before.stock <= 0 && before.status === 'active' && !before.deletedAt) {
      this.events.publish<ProductRestocked>(PRODUCT_EVENTS.restocked, { productId: String(before._id), title: before.title });
    }
  }

  async recordSale(productId: Types.ObjectId | string, quantity: number, revenue: number, at: Date): Promise<void> {
    await this.products.updateOne(
      { _id: productId },
      { $inc: { 'stats.unitsSold': quantity, 'stats.revenue': revenue }, $max: { 'stats.lastSaleAt': at } },
    );
    this.home.clear();
  }

  async reverseSale(productId: Types.ObjectId | string, quantity: number, revenue: number): Promise<void> {
    await this.products.updateOne({ _id: productId }, { $inc: { 'stats.unitsSold': -quantity, 'stats.revenue': -revenue } });
  }

  async incrementInquiries(productId: Types.ObjectId | string): Promise<void> {
    await this.products.updateOne({ _id: productId }, { $inc: { 'stats.inquiries': 1 } });
  }

  async setRating(productId: Types.ObjectId | string, average: number, count: number): Promise<void> {
    await this.products.updateOne({ _id: productId }, { $set: { 'stats.ratingAverage': average, 'stats.ratingCount': count } });
  }

  async adjustWishlistCount(productId: Types.ObjectId | string, delta: number): Promise<void> {
    await this.products.updateOne({ _id: productId }, { $inc: { 'stats.wishlists': delta } });
  }

  /** Keeps the "Verified sellers" facet true to the seller's identity check. */
  async syncSellerVerified(sellerId: string, verified: boolean): Promise<void> {
    await this.products.updateMany({ sellerId: new Types.ObjectId(sellerId) }, { $set: { sellerVerified: verified } });
    this.home.clear();
  }

  /** Takes a banned or suspended seller's listings off the storefront, remembering which to bring back. */
  async restrictSeller(sellerId: string): Promise<number> {
    const result = await this.products.updateMany(
      { sellerId: new Types.ObjectId(sellerId), status: 'active', deletedAt: null },
      { $set: { status: 'inactive' }, $addToSet: { 'moderation.flags': 'seller-restricted' } },
    );
    this.categories.invalidateCounts();
    this.home.clear();
    await this.recountActiveListings(sellerId);
    return result.modifiedCount;
  }

  async unrestrictSeller(sellerId: string): Promise<number> {
    const result = await this.products.updateMany(
      { sellerId: new Types.ObjectId(sellerId), status: 'inactive', 'moderation.flags': 'seller-restricted', deletedAt: null },
      { $set: { status: 'active' }, $pull: { 'moderation.flags': 'seller-restricted' } },
    );
    this.categories.invalidateCounts();
    this.home.clear();
    await this.recountActiveListings(sellerId);
    return result.modifiedCount;
  }
}
