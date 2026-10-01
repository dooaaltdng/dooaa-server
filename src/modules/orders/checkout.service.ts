import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import type { CheckoutMethod } from '../../common/domain';
import { orderReference } from '../../common/util/ids';
import type { Lean } from '../../common/util/mongo';
import { CartService, pricingSettings } from '../cart/cart.service';
import type { DeliveryInfo } from '../cart/cart.schema';
import { Offer } from '../conversations/schemas/offer.schema';
import { CouponsService } from '../coupons/coupons.service';
import {
  PAYMENT_EVENTS,
  PaymentsService,
  type PaymentFailed,
  type PaymentSucceeded,
  type PaymentView,
  type RefundUpdated,
} from '../payments/payments.service';
import { ProductsService } from '../products/products.service';
import type { Product } from '../products/schemas/product.schema';
import { SettingsService } from '../settings/settings.service';
import { OrdersService } from './orders.service';
import { priceCart, priceEscrow, type EscrowQuote } from './pricing';
import type { BuyerOrderView } from './order.presenter';
import { Order } from './schemas/order.schema';

export type CheckoutResult = {
  checkoutId: string;
  orders: BuyerOrderView[];
  payment: PaymentView;
};

function skuFor(productId: Types.ObjectId): string {
  return `DOO-${String(productId).slice(-6).toUpperCase()}`;
}

@Injectable()
export class CheckoutService implements OnModuleInit {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    @InjectModel(Offer.name) private readonly offers: Model<Offer>,
    private readonly orders: OrdersService,
    private readonly cart: CartService,
    private readonly coupons: CouponsService,
    private readonly payments: PaymentsService,
    private readonly products: ProductsService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<PaymentSucceeded>(PAYMENT_EVENTS.succeeded, (event) => this.onPaid(event));
    this.events.on<PaymentFailed>(PAYMENT_EVENTS.failed, (event) => this.orders.abandon(event.payment.orderIds, this.failureCopy(event.reason)));
    this.events.on<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, async (event) => {
      if (event.refund.orderId) {
        await this.orders.applyRefundOutcome(event.refund.orderId, {
          status: event.refund.status,
          processedAt: event.refund.processedAt,
          failureReason: event.refund.failureReason,
        });
      }
    });
  }

  private failureCopy(reason: string): string {
    if (reason === 'expired') return 'Payment was not completed in time.';
    if (reason === 'amount-mismatch') return 'The payment amount did not match the order and has been returned.';
    if (reason === 'provider-error') return 'Payment could not be started.';
    return 'Payment was not completed.';
  }

  /** Fulfils everything a confirmed charge paid for. Safe to run more than once. */
  private async onPaid({ payment }: PaymentSucceeded): Promise<void> {
    const funded = await this.orders.fund(payment.orderIds, {
      reference: payment.reference,
      provider: payment.provider,
      paidAt: payment.paidAt,
      card: payment.card,
      channel: payment.channel,
    });
    const all = await this.orderModel.find({ _id: { $in: payment.orderIds } }).lean<Lean<Order>[]>();
    // Bought items leave the cart; the coupon is spent once per checkout.
    await this.cart.emptyAfterCheckout(String(payment.buyerId), all.flatMap((order) => order.items.map((item) => item.productId)));
    const coupon = funded.find((order) => order.couponCode)?.couponCode;
    if (coupon) await this.coupons.redeem(coupon);
    for (const order of funded) {
      if (order.offerId) await this.offers.updateOne({ _id: order.offerId, status: 'accepted' }, { $set: { status: 'used', orderId: order._id } });
    }
  }

  /* --- Quotes --------------------------------------------------------------------- */

  private async agreedPrice(user: AuthUser, product: Lean<Product>, offerId?: string): Promise<{ price: number; offerId?: Types.ObjectId }> {
    if (!offerId) return { price: product.price };
    const offer = await this.offers.findOne({ _id: offerId, buyerId: new Types.ObjectId(user.id), productId: product._id }).lean<Lean<Offer>>();
    if (!offer) throw Errors.notFound('That offer is not available.', 'OFFER_NOT_FOUND');
    if (offer.status !== 'accepted' || !offer.agreedAmount) throw Errors.conflict('That offer has not been accepted.', 'OFFER_NOT_ACCEPTED');
    return { price: offer.agreedAmount, offerId: offer._id };
  }

  /** What "Buy via Escrow" will charge, before the buyer commits. */
  async quoteEscrow(user: AuthUser, productId: string, quantity = 1, offerId?: string): Promise<{ productId: string; title: string; image: string | null; seller: string; quote: EscrowQuote }> {
    const product = await this.products.findPublic(productId);
    if (String(product.sellerId) === user.id) throw Errors.forbidden('You cannot buy your own listing.', 'OWN_LISTING');
    const { price } = await this.agreedPrice(user, product, offerId);
    const quote = priceEscrow(price, quantity, await pricingSettings(this.settings));
    return { productId, title: product.title, image: product.images[0] ?? null, seller: String(product.sellerId), quote };
  }

  /* --- Checkout ------------------------------------------------------------------ */

  private requireVerified(user: AuthUser): void {
    if (!user.emailVerified) throw Errors.forbidden('Verify your email address before you check out.', 'EMAIL_NOT_VERIFIED');
  }

  /** Holds stock for every line, all or nothing. */
  private async reserveAll(lines: { productId: Types.ObjectId; quantity: number }[]): Promise<Lean<Product>[]> {
    const held: { productId: Types.ObjectId; quantity: number }[] = [];
    const products: Lean<Product>[] = [];
    for (const line of lines) {
      const product = await this.products.reserveStock(line.productId, line.quantity);
      if (!product) {
        for (const done of held) await this.products.releaseStock(done.productId, done.quantity);
        const current = await this.products.findById(line.productId);
        throw Errors.conflict(
          current && current.status === 'active' ? `Only ${current.stock} of “${current.title}” left.` : 'An item in your cart is no longer available.',
          'INSUFFICIENT_STOCK',
          { productId: String(line.productId), available: current?.stock ?? 0 },
        );
      }
      held.push(line);
      products.push(product);
    }
    return products;
  }

  private async release(lines: { productId: Types.ObjectId; quantity: number }[]): Promise<void> {
    for (const line of lines) await this.products.releaseStock(line.productId, line.quantity);
  }

  private async charge(user: AuthUser, orderIds: Types.ObjectId[], checkoutId: string, amount: number, method: CheckoutMethod, savedCardId?: string): Promise<CheckoutResult> {
    const payment = await this.payments.startCharge({
      buyer: { id: user.id, email: user.email },
      orderIds,
      checkoutId,
      amount,
      method,
      savedCardId,
    });
    await this.orderModel.updateMany({ _id: { $in: orderIds } }, { $set: { 'payment.reference': payment.reference, 'payment.provider': payment.provider } });
    const rows = await this.orderModel.find({ _id: { $in: orderIds } }).sort({ createdAt: 1 }).lean<Lean<Order>[]>();
    return { checkoutId, orders: await this.orders.buyerViews(rows), payment: this.payments.view(payment) };
  }

  /** Cart checkout: one order per seller, one charge for all of them. */
  async checkoutCart(user: AuthUser, input: { method: CheckoutMethod; savedCardId?: string; delivery?: DeliveryInfo }): Promise<CheckoutResult> {
    this.requireVerified(user);
    const cart = await this.cart.raw(user.id);
    const delivery = input.delivery ? { ...input.delivery, state: input.delivery.state ?? '', zip: input.delivery.zip ?? '' } : cart.delivery;
    if (!delivery) throw Errors.badRequest('Add your delivery information before paying.', 'DELIVERY_REQUIRED');

    // Lines that can actually be bought right now.
    const view = await this.cart.view(user);
    const lines = view.entries
      .filter((entry) => entry.available && entry.quantity > 0)
      .map((entry) => ({ productId: new Types.ObjectId(entry.product.id), quantity: entry.quantity }));
    if (!lines.length) throw Errors.badRequest('Your cart has nothing that can be bought right now.', 'CART_EMPTY');

    const reserved = await this.reserveAll(lines);
    let orderIds: Types.ObjectId[] = [];
    try {
      const settings = await pricingSettings(this.settings);
      const coupon = await this.coupons.usable(cart.couponCode);
      const quantities = new Map(lines.map((line) => [String(line.productId), line.quantity]));
      const pricing = priceCart(
        reserved.map((product) => ({ productId: String(product._id), sellerId: String(product.sellerId), unitPrice: product.price, quantity: quantities.get(String(product._id))! })),
        coupon,
        settings,
      );
      const byId = new Map(reserved.map((product) => [String(product._id), product]));
      const checkoutId = `chk_${randomBytes(8).toString('hex')}`;
      const expiresAt = new Date(Date.now() + (await this.settings.section('commerce')).unpaidOrderTtlMinutes * 60_000);
      const created = await this.orderModel.insertMany(
        pricing.groups.map((group) => ({
          reference: orderReference(),
          checkoutId,
          buyerId: new Types.ObjectId(user.id),
          sellerId: new Types.ObjectId(group.sellerId),
          kind: 'standard',
          items: group.lines.map((line) => {
            const product = byId.get(line.productId)!;
            return { productId: product._id, title: product.title, sku: skuFor(product._id), quantity: line.quantity, price: line.unitPrice, image: product.images[0] ?? '', condition: product.condition };
          }),
          subtotal: group.subtotal,
          discount: group.discount,
          taxRate: group.taxRate,
          tax: group.tax,
          shipping: group.shipping,
          escrowFee: group.escrowFee,
          total: group.total,
          commission: group.commission,
          sellerEarning: group.sellerEarning,
          couponCode: group.discount > 0 ? (pricing.coupon ?? undefined) : undefined,
          delivery,
          payment: { method: input.method, status: 'pending' },
          status: 'awaiting-payment',
          expiresAt,
        })),
      );
      orderIds = created.map((order) => order._id);
      return await this.charge(user, orderIds, checkoutId, pricing.total, input.method, input.savedCardId);
    } catch (error) {
      // Once orders exist, abandoning them returns their stock exactly once (it is a no-op if the
      // payment-failed handler already did); before that, the hold is released here.
      if (orderIds.length) await this.orders.abandon(orderIds, 'Payment could not be started.');
      else await this.release(lines);
      throw error;
    }
  }

  /** "Buy Now via Escrow": a single item, at the listed price or an accepted offer. */
  async checkoutEscrow(
    user: AuthUser,
    input: { productId: string; quantity?: number; method: CheckoutMethod; savedCardId?: string; offerId?: string; delivery: DeliveryInfo },
  ): Promise<CheckoutResult & { quote: EscrowQuote }> {
    this.requireVerified(user);
    if (!(await this.settings.section('escrow')).enabled) {
      throw Errors.badRequest('Escrow purchases are paused right now. Add the item to your cart instead.', 'ESCROW_DISABLED');
    }
    const quantity = input.quantity ?? 1;
    const product = await this.products.findPublic(input.productId);
    if (String(product.sellerId) === user.id) throw Errors.forbidden('You cannot buy your own listing.', 'OWN_LISTING');
    const { price, offerId } = await this.agreedPrice(user, product, input.offerId);

    const lines = [{ productId: product._id, quantity }];
    const [reserved] = await this.reserveAll(lines);
    let orderId: Types.ObjectId | null = null;
    try {
      const quote = priceEscrow(price, quantity, await pricingSettings(this.settings));
      const checkoutId = `chk_${randomBytes(8).toString('hex')}`;
      const expiresAt = new Date(Date.now() + (await this.settings.section('commerce')).unpaidOrderTtlMinutes * 60_000);
      const order = await this.orderModel.create({
        reference: orderReference(),
        checkoutId,
        buyerId: new Types.ObjectId(user.id),
        sellerId: reserved.sellerId,
        kind: 'escrow',
        items: [{ productId: reserved._id, title: reserved.title, sku: skuFor(reserved._id), quantity, price, image: reserved.images[0] ?? '', condition: reserved.condition }],
        subtotal: quote.subtotal,
        discount: 0,
        taxRate: quote.taxRate,
        tax: quote.tax,
        shipping: quote.deliveryFee,
        escrowFee: quote.escrowFee,
        total: quote.total,
        commission: quote.commission,
        sellerEarning: quote.sellerEarning,
        delivery: { ...input.delivery, state: input.delivery.state ?? '', zip: input.delivery.zip ?? '' },
        payment: { method: input.method, status: 'pending' },
        status: 'awaiting-payment',
        offerId,
        expiresAt,
      });
      orderId = order._id;
      const result = await this.charge(user, [order._id], checkoutId, quote.total, input.method, input.savedCardId);
      return { ...result, quote };
    } catch (error) {
      if (orderId) await this.orders.abandon([orderId], 'Payment could not be started.');
      else await this.release(lines);
      throw error;
    }
  }
}
