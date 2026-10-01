import { CONDITION_LABEL, DELIVERY_LABEL, type Collection, type Condition, type ListingStatus } from '../../common/domain';
import { tenureLabel, yearsSince } from '../../common/util/dates';
import type { Lean } from '../../common/util/mongo';
import type { User } from '../users/schemas/user.schema';
import type { Product } from './schemas/product.schema';

/** A product card — the storefront grids, rails, wishlist and cart. */
export type ProductCard = {
  id: string;
  title: string;
  summary: string;
  price: number;
  previousPrice: number | null;
  location: string;
  condition: Condition;
  conditionLabel: string;
  image: string | null;
  categoryId: string;
  categoryName: string;
  brand: string | null;
  collections: Collection[];
  createdAt: string;
  sellerId: string;
  verifiedSeller: boolean;
  stock: number;
  inStock: boolean;
  pricing: Product['pricing'];
  paymentMethod: Product['paymentMethod'];
  rating: number;
  ratingCount: number;
  wishlisted: boolean;
};

export type SellerPanel = {
  id: string;
  name: string;
  storeName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  /** "5+ years on DOOAA". */
  tenure: string;
  /** "Delivery within 3 days". */
  dispatch: string;
  /** "Typically responds within an hour". */
  response: string;
  location: string;
  /** "Nationwide Delivery (1-3 business days within Lagos)". */
  delivery: string;
  rating: number;
  ratingCount: number;
  memberSince: string;
};

export type ProductDetail = ProductCard & {
  description: string;
  specs: string[];
  gallery: string[];
  videos: { url: string; posterUrl: string | null }[];
  delivery: Product['delivery'];
  deliveryLabel: string;
  seller: SellerPanel;
  breadcrumb: string[];
};

/** The seller's own listing row (Products tab, product page, edit form). */
export type SellerProductView = {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  highlights: string[];
  payment: Product['paymentMethod'];
  price: number;
  previousPrice: number | null;
  pricing: Product['pricing'];
  condition: Condition;
  stock: number;
  category: string;
  categoryName: string;
  brand: string | null;
  location: string;
  delivery: Product['delivery'];
  status: ListingStatus;
  /** What the status pill shows: Active, Draft, Out of stock, Pending… */
  displayStatus: 'active' | 'draft' | 'out-of-stock' | 'pending' | 'inactive' | 'suspicious' | 'rejected';
  stockStatus: 'in-stock' | 'out-of-stock';
  moderationNote: string | null;
  moderationFlags: string[];
  images: string[];
  videos: { url: string; posterUrl: string | null }[];
  unitsSold: number;
  revenue: number;
  views: number;
  wishlists: number;
  lastSaleAt: string | null;
  createdAt: string;
  publishedAt: string | null;
};

/** One row of the console's Items & Listing table, with the details dialog's fields. */
export type AdminListingView = {
  id: string;
  title: string;
  category: string;
  categoryName: string;
  description: string;
  highlights: string[];
  additionalDescription: string[];
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  sellerAvatar: string | null;
  sellerVerified: boolean;
  sellerYears: number;
  sellerResponse: string;
  sellerLocation: string;
  sellerDelivery: string;
  deliveryPromise: string;
  price: number;
  previousPrice: number | null;
  priceSince: string | null;
  previousPriceSince: string | null;
  stock: number;
  inventory: number;
  status: ListingStatus;
  pricing: Product['pricing'];
  payment: Product['paymentMethod'];
  delivery: Product['delivery'];
  listedAs: Product['listedAs'];
  listedOn: string;
  inquiries: number;
  featured: boolean;
  moderationFlags: string[];
  moderationNote: string | null;
  media: { id: string; kind: 'image' | 'video'; url: string; posterUrl: string | null }[];
};

export type PresenterContext = {
  categoryNames: Map<string, string>;
  wishlisted?: Set<string>;
};

function collectionsOf(product: Lean<Product>): Collection[] {
  const out: Collection[] = [];
  if (product.featured) out.push('featured');
  if ((product.stats?.unitsSold ?? 0) > 0) out.push('top-sellers');
  if ((product.stats?.views ?? 0) > 0) out.push('popular');
  return out;
}

export function displayStatus(product: Pick<Product, 'status' | 'stock'>): SellerProductView['displayStatus'] {
  if (product.status === 'active' && product.stock <= 0) return 'out-of-stock';
  return product.status;
}

export function toProductCard(product: Lean<Product>, context: PresenterContext): ProductCard {
  const id = String(product._id);
  return {
    id,
    title: product.title,
    summary: product.summary,
    price: product.price,
    previousPrice: product.previousPrice ?? null,
    location: product.location,
    condition: product.condition,
    conditionLabel: CONDITION_LABEL[product.condition],
    image: product.images[0] ?? product.videos[0]?.posterUrl ?? null,
    categoryId: product.categoryId,
    categoryName: context.categoryNames.get(product.categoryId) ?? product.categoryId,
    brand: product.brand ?? null,
    collections: collectionsOf(product),
    createdAt: new Date(product.publishedAt ?? product.createdAt).toISOString(),
    sellerId: String(product.sellerId),
    verifiedSeller: product.sellerVerified,
    stock: product.stock,
    inStock: product.status === 'active' && product.stock > 0,
    pricing: product.pricing,
    paymentMethod: product.paymentMethod,
    rating: product.stats?.ratingAverage ?? 0,
    ratingCount: product.stats?.ratingCount ?? 0,
    wishlisted: context.wishlisted?.has(id) ?? false,
  };
}

export function toSellerPanel(seller: Lean<User> | null): SellerPanel {
  if (!seller) {
    return {
      id: '',
      name: 'DOOAA Seller',
      storeName: null,
      avatarUrl: null,
      verified: false,
      tenure: 'New on DOOAA',
      dispatch: 'Delivery within 3 days',
      response: 'Typically responds within a few hours',
      location: 'Lagos, Nigeria',
      delivery: 'Nationwide Delivery (1-3 business days within Lagos)',
      rating: 0,
      ratingCount: 0,
      memberSince: new Date().getUTCFullYear().toString(),
    };
  }
  const days = seller.seller?.dispatchDays ?? 3;
  return {
    id: String(seller._id),
    name: `${seller.firstName} ${seller.lastName}`.trim(),
    storeName: seller.seller?.storeName ?? null,
    avatarUrl: seller.avatarUrl ?? null,
    verified: seller.identity === 'verified',
    tenure: tenureLabel(seller.createdAt),
    dispatch: `Delivery within ${days} ${days === 1 ? 'day' : 'days'}`,
    response: seller.seller?.responseLabel ?? 'Typically responds within a few hours',
    location: seller.location ? `${seller.location}, Nigeria` : 'Lagos, Nigeria',
    delivery: seller.seller?.deliveryLabel ?? 'Nationwide Delivery (1-3 business days within Lagos)',
    rating: seller.stats?.ratingAverage ?? 0,
    ratingCount: seller.stats?.ratingCount ?? 0,
    memberSince: new Date(seller.createdAt).getUTCFullYear().toString(),
  };
}

export function toProductDetail(product: Lean<Product>, seller: Lean<User> | null, context: PresenterContext): ProductDetail {
  const card = toProductCard(product, context);
  return {
    ...card,
    description: product.description,
    specs: product.highlights,
    gallery: product.images,
    videos: product.videos.map((video) => ({ url: video.url, posterUrl: video.posterUrl ?? null })),
    delivery: product.delivery,
    deliveryLabel: DELIVERY_LABEL[product.delivery],
    seller: toSellerPanel(seller),
    breadcrumb: ['Home', card.categoryName],
  };
}

export function toSellerProduct(product: Lean<Product>, categoryNames: Map<string, string>): SellerProductView {
  return {
    id: String(product._id),
    sellerId: String(product.sellerId),
    title: product.title,
    description: product.description,
    highlights: product.highlights,
    payment: product.paymentMethod,
    price: product.price,
    previousPrice: product.previousPrice ?? null,
    pricing: product.pricing,
    condition: product.condition,
    stock: product.stock,
    category: product.categoryId,
    categoryName: categoryNames.get(product.categoryId) ?? product.categoryId,
    brand: product.brand ?? null,
    location: product.location,
    delivery: product.delivery,
    status: product.status,
    displayStatus: displayStatus(product),
    stockStatus: product.stock > 0 ? 'in-stock' : 'out-of-stock',
    moderationNote: product.moderation?.note ?? null,
    moderationFlags: product.moderation?.flags ?? [],
    images: product.images,
    videos: product.videos.map((video) => ({ url: video.url, posterUrl: video.posterUrl ?? null })),
    unitsSold: product.stats?.unitsSold ?? 0,
    revenue: product.stats?.revenue ?? 0,
    views: product.stats?.views ?? 0,
    wishlists: product.stats?.wishlists ?? 0,
    lastSaleAt: product.stats?.lastSaleAt ? new Date(product.stats.lastSaleAt).toISOString() : null,
    createdAt: new Date(product.createdAt).toISOString(),
    publishedAt: product.publishedAt ? new Date(product.publishedAt).toISOString() : null,
  };
}

export function toAdminListing(product: Lean<Product>, seller: Lean<User> | null, categoryNames: Map<string, string>): AdminListingView {
  const panel = toSellerPanel(seller);
  const id = String(product._id);
  return {
    id,
    title: product.title,
    category: product.categoryId,
    categoryName: categoryNames.get(product.categoryId) ?? product.categoryId,
    description: product.description,
    highlights: product.highlights,
    additionalDescription: product.highlights,
    sellerId: String(product.sellerId),
    sellerName: seller ? `${seller.firstName} ${seller.lastName}`.trim() : panel.name,
    sellerEmail: seller?.email ?? '',
    sellerAvatar: seller?.avatarUrl ?? null,
    sellerVerified: panel.verified,
    sellerYears: seller ? yearsSince(seller.createdAt) : 1,
    sellerResponse: panel.response,
    sellerLocation: panel.location,
    sellerDelivery: panel.delivery,
    deliveryPromise: panel.dispatch,
    price: product.price,
    previousPrice: product.previousPrice ?? null,
    priceSince: (product.priceChangedAt ?? product.publishedAt ?? product.createdAt)?.toISOString?.() ?? null,
    previousPriceSince: product.previousPriceSince ? new Date(product.previousPriceSince).toISOString() : null,
    stock: product.stock,
    inventory: product.stock + (product.stats?.unitsSold ?? 0),
    status: product.status,
    pricing: product.pricing,
    payment: product.paymentMethod,
    delivery: product.delivery,
    listedAs: product.listedAs,
    listedOn: new Date(product.publishedAt ?? product.createdAt).toISOString(),
    inquiries: product.stats?.inquiries ?? 0,
    featured: product.featured,
    moderationFlags: product.moderation?.flags ?? [],
    moderationNote: product.moderation?.note ?? null,
    media: [
      ...product.images.map((url, index) => ({ id: `${id}_img_${index}`, kind: 'image' as const, url, posterUrl: null })),
      ...product.videos.map((video, index) => ({ id: `${id}_vid_${index}`, kind: 'video' as const, url: video.url, posterUrl: video.posterUrl ?? null })),
    ],
  };
}
