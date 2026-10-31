import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { cartItems, carts, type DeliveryInfo } from '../../database/schema';
import { CouponsService } from '../coupons/coupons.service';
import { priceCart, type PricingSettings } from '../orders/pricing';
import type { ProductCard } from '../products/product.presenter';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import type { DeliveryInfoDto } from './dto/cart.dto';

/** A buyer's cart: its lines in the order they were added, the coupon and the delivery details. */
export type Cart = {
  userId: string;
  lines: { productId: string; quantity: number; addedAt: Date }[];
  couponCode: string | null;
  delivery: DeliveryInfo | null;
};

const MAX_LINES = 50;

export type CartEntry = {
  product: ProductCard;
  quantity: number;
  lineTotal: number;
  /** False when the item can no longer be bought (sold out, unlisted, your own). */
  available: boolean;
  issue: string | null;
};

export type CartView = {
  entries: CartEntry[];
  count: number;
  sellers: number;
  subtotal: number;
  delivery: number;
  discount: number;
  tax: number;
  total: number;
  coupon: string | null;
  deliveryInfo: DeliveryInfo | null;
};

export async function pricingSettings(settings: SettingsService): Promise<PricingSettings> {
  const all = await settings.get();
  return {
    deliveryFee: all.commerce.deliveryFee,
    escrowDeliveryFee: all.commerce.escrowDeliveryFee,
    taxRate: all.commerce.taxRate,
    escrowFeePercent: all.escrow.feePercent,
    escrowMinimumFee: all.escrow.minimumFee,
    commissionPercent: all.commerce.commissionPercent,
  };
}

@Injectable()
export class CartService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly products: ProductsService,
    private readonly coupons: CouponsService,
    private readonly settings: SettingsService,
  ) {}

  /** The user's cart, created on first use. */
  private async load(userId: string): Promise<Cart> {
    const [cart, rows] = await Promise.all([
      this.db.upsert(carts, { userId }, {}),
      this.db.find(cartItems, { userId }, { sort: { addedAt: 1 } }),
    ]);
    const lines = rows.map((row) => ({ productId: row.productId, quantity: row.quantity, addedAt: row.addedAt }));
    return { userId, lines, couponCode: cart.couponCode, delivery: cart.delivery };
  }

  /** The cart, priced the way checkout will price it. */
  async view(user: AuthUser): Promise<CartView> {
    const cart = await this.load(user.id);
    return this.price(user, cart);
  }

  private async price(user: AuthUser, cart: Cart): Promise<CartView> {
    const ids = cart.lines.map((line) => line.productId);
    const [rows, cards] = await Promise.all([this.products.byIds(ids), this.products.cardsByIds(ids, user, true)]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const cardById = new Map(cards.map((card) => [card.id, card]));

    // With escrow off, marketplace sellers are paid outside DOOAA: their listings are bought through a chat, not the cart.
    const chatOnly = !(await this.settings.section('escrow')).enabled;
    const entries: CartEntry[] = [];
    const pricedLines: { productId: string; sellerId: string; unitPrice: number; quantity: number }[] = [];
    for (const line of cart.lines) {
      const product = byId.get(line.productId);
      const card = cardById.get(line.productId);
      if (!product || !card || product.deletedAt) continue;
      let issue: string | null = null;
      if (product.sellerId === user.id) issue = 'This is your own listing.';
      else if (chatOnly && product.listedAs === 'seller') issue = 'Chat the seller to buy this item.';
      else if (product.status !== 'active') issue = 'This item is no longer available.';
      else if (product.stock <= 0) issue = 'Sold out.';
      else if (product.stock < line.quantity) issue = `Only ${product.stock} left — we will check out ${product.stock}.`;
      const available = issue === null || (product.stock > 0 && product.status === 'active' && product.sellerId !== user.id && !(chatOnly && product.listedAs === 'seller'));
      const quantity = available ? Math.min(line.quantity, product.stock) : line.quantity;
      if (available) pricedLines.push({ productId: product.id, sellerId: product.sellerId, unitPrice: product.price, quantity });
      entries.push({ product: card, quantity, lineTotal: Math.round(product.price * quantity * 100) / 100, available, issue });
    }

    const coupon = await this.coupons.usable(cart.couponCode);
    const pricing = priceCart(pricedLines, coupon, await pricingSettings(this.settings));
    return {
      entries,
      count: pricing.count,
      sellers: pricing.groups.length,
      subtotal: pricing.subtotal,
      delivery: pricing.delivery,
      discount: pricing.discount,
      tax: pricing.tax,
      total: pricing.total,
      coupon: coupon ? coupon.code : null,
      deliveryInfo: cart.delivery,
    };
  }

  private async assertBuyable(user: AuthUser, productId: string, quantity: number) {
    const product = await this.products.findPublic(productId);
    if (product.sellerId === user.id) throw Errors.forbidden('You cannot buy your own listing.', 'OWN_LISTING');
    if (product.listedAs === 'seller' && !(await this.settings.section('escrow')).enabled) {
      throw Errors.conflict('Chat the seller to buy this item.', 'CHAT_SELLER');
    }
    if (product.stock <= 0) throw Errors.conflict('This item is sold out.', 'OUT_OF_STOCK');
    if (quantity > product.stock) throw Errors.conflict(`Only ${product.stock} left in stock.`, 'INSUFFICIENT_STOCK', { available: product.stock });
    return product;
  }

  async add(user: AuthUser, productId: string, quantity = 1): Promise<CartView> {
    const cart = await this.load(user.id);
    const existing = cart.lines.find((line) => line.productId === productId);
    const next = (existing?.quantity ?? 0) + quantity;
    await this.assertBuyable(user, productId, next);
    if (!existing && cart.lines.length >= MAX_LINES) throw Errors.conflict('Your cart is full. Check out or remove something first.', 'CART_FULL');
    await this.db.upsert(cartItems, { userId: user.id, productId }, { quantity: next });
    // A new line (not a quantity bump) counts towards the product's Popular ranking.
    if (!existing) void this.products.recordCartAdd(productId).catch(() => undefined);
    return this.view(user);
  }

  async setQuantity(user: AuthUser, productId: string, quantity: number): Promise<CartView> {
    const cart = await this.load(user.id);
    if (!cart.lines.some((line) => line.productId === productId)) {
      throw Errors.notFound('That item is not in your cart.', 'CART_ITEM_NOT_FOUND');
    }
    await this.assertBuyable(user, productId, quantity);
    await this.db.update(cartItems, { userId: user.id, productId }, { quantity });
    return this.view(user);
  }

  async remove(user: AuthUser, productId: string): Promise<CartView> {
    if (isUuid(productId)) await this.db.delete(cartItems, { userId: user.id, productId });
    return this.view(user);
  }

  async clear(user: AuthUser): Promise<CartView> {
    await this.db.transaction(async (tx) => {
      await tx.deleteMany(cartItems, { userId: user.id });
      await tx.update(carts, { userId: user.id }, { couponCode: null });
    });
    return this.view(user);
  }

  async applyCoupon(user: AuthUser, code: string): Promise<CartView> {
    const coupon = await this.coupons.require(code);
    const cart = await this.load(user.id);
    const view = await this.price(user, { ...cart, couponCode: coupon.code });
    if (view.subtotal <= 0) throw Errors.badRequest('Add something to your cart before applying a coupon.', 'COUPON_NOT_APPLICABLE');
    if (view.discount <= 0) {
      throw Errors.badRequest(
        coupon.minSubtotal ? `This code needs a subtotal of at least ₦${coupon.minSubtotal.toLocaleString('en-NG')}.` : "That coupon code isn't valid.",
        'COUPON_NOT_APPLICABLE',
      );
    }
    await this.db.update(carts, { userId: cart.userId }, { couponCode: coupon.code });
    return view;
  }

  async removeCoupon(user: AuthUser): Promise<CartView> {
    await this.db.update(carts, { userId: user.id }, { couponCode: null });
    return this.view(user);
  }

  async setDelivery(user: AuthUser, input: DeliveryInfoDto): Promise<CartView> {
    await this.db.upsert(carts, { userId: user.id }, { delivery: { ...input, state: input.state ?? '', zip: input.zip ?? '' } });
    return this.view(user);
  }

  /** Folds a guest's in-browser cart into the account after sign-in. Unbuyable lines are skipped. */
  async merge(user: AuthUser, items: { productId: string; quantity?: number }[]): Promise<CartView> {
    for (const item of items) {
      try {
        await this.add(user, item.productId, item.quantity ?? 1);
      } catch {
        // Sold out, unlisted or own listing: the guest line is dropped.
      }
    }
    return this.view(user);
  }

  /** Used by checkout: the raw lines and delivery, without pricing. */
  async raw(userId: string): Promise<Cart> {
    return this.load(userId);
  }

  async emptyAfterCheckout(userId: string, productIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (productIds.length) await tx.deleteMany(cartItems, { userId, productId: { $in: productIds } });
      await tx.update(carts, { userId }, { couponCode: null });
    });
  }

  /** How many lines are in the cart (the header badge). */
  async countLines(userId: string): Promise<number> {
    return this.db.count(cartItems, { userId });
  }
}
