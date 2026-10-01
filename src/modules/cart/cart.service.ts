import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import type { Lean } from '../../common/util/mongo';
import { CouponsService } from '../coupons/coupons.service';
import { priceCart, type PricingSettings } from '../orders/pricing';
import { ProductsService } from '../products/products.service';
import type { ProductCard } from '../products/product.presenter';
import { Product } from '../products/schemas/product.schema';
import { SettingsService } from '../settings/settings.service';
import { Cart, type DeliveryInfo } from './cart.schema';
import type { DeliveryInfoDto } from './dto/cart.dto';

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
    @InjectModel(Cart.name) private readonly carts: Model<Cart>,
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    private readonly products: ProductsService,
    private readonly coupons: CouponsService,
    private readonly settings: SettingsService,
  ) {}

  private async load(userId: string): Promise<Lean<Cart>> {
    const cart = await this.carts
      .findOneAndUpdate({ userId: new Types.ObjectId(userId) }, { $setOnInsert: { lines: [] } }, { upsert: true, returnDocument: 'after' })
      .lean<Lean<Cart>>();
    return cart!;
  }

  /** The cart, priced the way checkout will price it. */
  async view(user: AuthUser): Promise<CartView> {
    const cart = await this.load(user.id);
    return this.price(user, cart);
  }

  private async price(user: AuthUser, cart: Lean<Cart>): Promise<CartView> {
    const ids = cart.lines.map((line) => line.productId);
    const [rows, cards] = await Promise.all([
      this.productModel.find({ _id: { $in: ids } }).lean<Lean<Product>[]>(),
      this.products.cardsByIds(ids, user, true),
    ]);
    const byId = new Map(rows.map((row) => [String(row._id), row]));
    const cardById = new Map(cards.map((card) => [card.id, card]));

    const entries: CartEntry[] = [];
    const pricedLines: { productId: string; sellerId: string; unitPrice: number; quantity: number }[] = [];
    for (const line of cart.lines) {
      const product = byId.get(String(line.productId));
      const card = cardById.get(String(line.productId));
      if (!product || !card || product.deletedAt) continue;
      let issue: string | null = null;
      if (String(product.sellerId) === user.id) issue = 'This is your own listing.';
      else if (product.status !== 'active') issue = 'This item is no longer available.';
      else if (product.stock <= 0) issue = 'Sold out.';
      else if (product.stock < line.quantity) issue = `Only ${product.stock} left — we will check out ${product.stock}.`;
      const available = issue === null || (product.stock > 0 && product.status === 'active' && String(product.sellerId) !== user.id);
      const quantity = available ? Math.min(line.quantity, product.stock) : line.quantity;
      if (available) pricedLines.push({ productId: String(product._id), sellerId: String(product.sellerId), unitPrice: product.price, quantity });
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
      deliveryInfo: cart.delivery ?? null,
    };
  }

  private async assertBuyable(user: AuthUser, productId: string, quantity: number): Promise<Lean<Product>> {
    const product = await this.products.findPublic(productId);
    if (String(product.sellerId) === user.id) throw Errors.forbidden('You cannot buy your own listing.', 'OWN_LISTING');
    if (product.stock <= 0) throw Errors.conflict('This item is sold out.', 'OUT_OF_STOCK');
    if (quantity > product.stock) throw Errors.conflict(`Only ${product.stock} left in stock.`, 'INSUFFICIENT_STOCK', { available: product.stock });
    return product;
  }

  async add(user: AuthUser, productId: string, quantity = 1): Promise<CartView> {
    const cart = await this.load(user.id);
    const existing = cart.lines.find((line) => String(line.productId) === productId);
    const next = (existing?.quantity ?? 0) + quantity;
    await this.assertBuyable(user, productId, next);
    if (!existing && cart.lines.length >= MAX_LINES) throw Errors.conflict('Your cart is full. Check out or remove something first.', 'CART_FULL');
    if (existing) {
      await this.carts.updateOne({ _id: cart._id, 'lines.productId': existing.productId }, { $set: { 'lines.$.quantity': next } });
    } else {
      await this.carts.updateOne({ _id: cart._id }, { $push: { lines: { productId: new Types.ObjectId(productId), quantity, addedAt: new Date() } } });
    }
    return this.view(user);
  }

  async setQuantity(user: AuthUser, productId: string, quantity: number): Promise<CartView> {
    const cart = await this.load(user.id);
    if (!cart.lines.some((line) => String(line.productId) === productId)) {
      throw Errors.notFound('That item is not in your cart.', 'CART_ITEM_NOT_FOUND');
    }
    await this.assertBuyable(user, productId, quantity);
    await this.carts.updateOne({ _id: cart._id, 'lines.productId': new Types.ObjectId(productId) }, { $set: { 'lines.$.quantity': quantity } });
    return this.view(user);
  }

  async remove(user: AuthUser, productId: string): Promise<CartView> {
    await this.carts.updateOne({ userId: new Types.ObjectId(user.id) }, { $pull: { lines: { productId: new Types.ObjectId(productId) } } });
    return this.view(user);
  }

  async clear(user: AuthUser): Promise<CartView> {
    await this.carts.updateOne({ userId: new Types.ObjectId(user.id) }, { $set: { lines: [] }, $unset: { couponCode: 1 } });
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
    await this.carts.updateOne({ _id: cart._id }, { $set: { couponCode: coupon.code } });
    return view;
  }

  async removeCoupon(user: AuthUser): Promise<CartView> {
    await this.carts.updateOne({ userId: new Types.ObjectId(user.id) }, { $unset: { couponCode: 1 } });
    return this.view(user);
  }

  async setDelivery(user: AuthUser, input: DeliveryInfoDto): Promise<CartView> {
    await this.load(user.id);
    await this.carts.updateOne(
      { userId: new Types.ObjectId(user.id) },
      { $set: { delivery: { ...input, state: input.state ?? '', zip: input.zip ?? '' } } },
    );
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
  async raw(userId: string): Promise<Lean<Cart>> {
    return this.load(userId);
  }

  async emptyAfterCheckout(userId: string, productIds: Types.ObjectId[]): Promise<void> {
    await this.carts.updateOne(
      { userId: new Types.ObjectId(userId) },
      { $pull: { lines: { productId: { $in: productIds } } }, $unset: { couponCode: 1 } },
    );
  }
}
