import { Injectable, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import type { CheckoutMethod } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { orderReference } from '../../common/util/ids';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database, type Transaction } from '../../database/database';
import { offers, orderItems, orders, type DeliveryInfo } from '../../database/schema';
import { CartService, pricingSettings } from '../cart/cart.service';
import { CouponsService } from '../coupons/coupons.service';
import {
  PAYMENT_EVENTS,
  PaymentsService,
  type PaymentFailed,
  type PaymentSucceeded,
  type PaymentView,
  type RefundUpdated,
} from '../payments/payments.service';
import type { Product } from '../products/product.model';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import type { BuyerOrderView } from './order.presenter';
import { OrdersService } from './orders.service';
import { priceCart, priceEscrow, type EscrowQuote } from './pricing';

export type CheckoutResult = {
  checkoutId: string;
  orders: BuyerOrderView[];
  payment: PaymentView;
};

type Line = { productId: string; quantity: number };

function skuFor(productId: string): string {
  return `DOO-${productId.replace(/-/g, '').slice(-6).toUpperCase()}`;
}

@Injectable()
export class CheckoutService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Database,
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
      provider: payment.provider,
      paidAt: payment.paidAt,
      card: payment.cardLast4 ? { brand: payment.cardBrand, last4: payment.cardLast4 } : null,
      channel: payment.channel,
    });
    const all = await this.orders.findMany(payment.orderIds);
    // Bought items leave the cart; the coupon is spent once per checkout.
    await this.cart.emptyAfterCheckout(
      payment.buyerId,
      all.flatMap((order) => order.items.map((item) => item.productId)),
    );
    const coupon = funded.find((order) => order.couponCode)?.couponCode;
    if (coupon) await this.coupons.redeem(coupon);
    for (const order of funded) {
      if (order.offerId) {
        await this.db
          .update(offers)
          .set({ status: 'used', orderId: order.id })
          .where(and(eq(offers.id, order.offerId), eq(offers.status, 'accepted')));
      }
    }
  }

  /* --- Quotes --------------------------------------------------------------------- */

  private async agreedPrice(user: AuthUser, product: Product, offerId?: string): Promise<{ price: number; offerId?: string }> {
    if (!offerId) return { price: product.price };
    const [offer] = isUuid(offerId)
      ? await this.db
          .select()
          .from(offers)
          .where(and(eq(offers.id, offerId), eq(offers.buyerId, user.id), eq(offers.productId, product.id)))
      : [];
    if (!offer) throw Errors.notFound('That offer is not available.', 'OFFER_NOT_FOUND');
    if (offer.status !== 'accepted' || !offer.agreedAmount) throw Errors.conflict('That offer has not been accepted.', 'OFFER_NOT_ACCEPTED');
    return { price: offer.agreedAmount, offerId: offer.id };
  }

  /** What "Buy via Escrow" will charge, before the buyer commits. */
  async quoteEscrow(user: AuthUser, productId: string, quantity = 1, offerId?: string): Promise<{ productId: string; title: string; image: string | null; seller: string; quote: EscrowQuote }> {
    const product = await this.products.findPublic(productId);
    if (product.sellerId === user.id) throw Errors.forbidden('You cannot buy your own listing.', 'OWN_LISTING');
    const { price } = await this.agreedPrice(user, product, offerId);
    const quote = priceEscrow(price, quantity, await pricingSettings(this.settings));
    return { productId, title: product.title, image: product.images[0] ?? null, seller: product.sellerId, quote };
  }

  /* --- Checkout ------------------------------------------------------------------ */

  private requireVerified(user: AuthUser): void {
    if (!user.emailVerified) throw Errors.forbidden('Verify your email address before you check out.', 'EMAIL_NOT_VERIFIED');
  }

  /**
   * Holds stock for every line inside the checkout's transaction: if any
   * line is short, the whole checkout rolls back and every hold with it.
   */
  private async reserveAll(tx: Transaction, lines: Line[]): Promise<Product[]> {
    const held: Product[] = [];
    for (const line of lines) {
      const product = await this.products.reserveStock(line.productId, line.quantity, tx);
      if (!product) {
        const current = await this.products.findById(line.productId);
        throw Errors.conflict(
          current && current.status === 'active' ? `Only ${current.stock} of “${current.title}” left.` : 'An item in your cart is no longer available.',
          'INSUFFICIENT_STOCK',
          { productId: line.productId, available: current?.stock ?? 0 },
        );
      }
      held.push(product);
    }
    return held;
  }

  private async expiryWindow(): Promise<{ minutes: number; expiresAt: Date }> {
    const minutes = (await this.settings.section('commerce')).unpaidOrderTtlMinutes;
    return { minutes, expiresAt: new Date(Date.now() + minutes * 60_000) };
  }

  /** Opens the provider's checkout for the new orders. If that fails, the orders lapse and their stock comes back. */
  private async charge(user: AuthUser, orderIds: string[], checkoutId: string, amount: number, method: CheckoutMethod, expiresInMinutes: number): Promise<CheckoutResult> {
    try {
      const payment = await this.payments.startCharge({
        buyer: { id: user.id, email: user.email, name: `${user.firstName} ${user.lastName}`.trim(), phone: user.phone || undefined },
        orderIds,
        checkoutId,
        amount,
        method,
        expiresInMinutes,
      });
      const rows = await this.db.update(orders).set({ paymentReference: payment.reference, paymentProvider: payment.provider }).where(and(eq(orders.checkoutId, checkoutId))).returning();
      const created = await this.orders.withItems(rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)));
      return { checkoutId, orders: await this.orders.buyerViews(created), payment: this.payments.view(payment) };
    } catch (error) {
      // Abandoning returns each order's stock exactly once (a no-op if the payment-failed handler already did).
      await this.orders.abandon(orderIds, 'Payment could not be started.');
      throw error;
    }
  }

  /** Cart checkout: one order per seller, one charge for all of them. */
  async checkoutCart(user: AuthUser, input: { method: CheckoutMethod; delivery?: DeliveryInfo }): Promise<CheckoutResult> {
    this.requireVerified(user);
    const cart = await this.cart.raw(user.id);
    const delivery = input.delivery ? { ...input.delivery, state: input.delivery.state ?? '', zip: input.delivery.zip ?? '' } : cart.delivery;
    if (!delivery) throw Errors.badRequest('Add your delivery information before paying.', 'DELIVERY_REQUIRED');

    // Lines that can actually be bought right now.
    const view = await this.cart.view(user);
    const lines = view.entries.filter((entry) => entry.available && entry.quantity > 0).map((entry) => ({ productId: entry.product.id, quantity: entry.quantity }));
    if (!lines.length) throw Errors.badRequest('Your cart has nothing that can be bought right now.', 'CART_EMPTY');

    const settings = await pricingSettings(this.settings);
    const coupon = await this.coupons.usable(cart.couponCode);
    const window = await this.expiryWindow();
    const checkoutId = `chk_${randomBytes(8).toString('hex')}`;

    const { orderIds, total } = await this.db.transaction(async (tx) => {
      const reserved = await this.reserveAll(tx, lines);
      const quantities = new Map(lines.map((line) => [line.productId, line.quantity]));
      const pricing = priceCart(
        reserved.map((product) => ({ productId: product.id, sellerId: product.sellerId, unitPrice: product.price, quantity: quantities.get(product.id)! })),
        coupon,
        settings,
      );
      const byId = new Map(reserved.map((product) => [product.id, product]));
      const ids: string[] = [];
      for (const group of pricing.groups) {
        const [order] = await tx
          .insert(orders)
          .values({
            reference: orderReference(),
            checkoutId,
            buyerId: user.id,
            sellerId: group.sellerId,
            kind: 'standard',
            subtotal: group.subtotal,
            discount: group.discount,
            taxRate: group.taxRate,
            tax: group.tax,
            shipping: group.shipping,
            escrowFee: group.escrowFee,
            total: group.total,
            commission: group.commission,
            sellerEarning: group.sellerEarning,
            couponCode: group.discount > 0 ? (pricing.coupon ?? null) : null,
            delivery,
            paymentMethod: input.method,
            status: 'awaiting-payment',
            expiresAt: window.expiresAt,
          })
          .returning({ id: orders.id });
        await this.insertItems(
          tx,
          order.id,
          group.lines.map((line) => ({ product: byId.get(line.productId)!, quantity: line.quantity, price: line.unitPrice })),
        );
        ids.push(order.id);
      }
      return { orderIds: ids, total: pricing.total };
    });
    return this.charge(user, orderIds, checkoutId, total, input.method, window.minutes);
  }

  /** "Buy Now via Escrow": a single item, at the listed price or an accepted offer. */
  async checkoutEscrow(
    user: AuthUser,
    input: { productId: string; quantity?: number; method: CheckoutMethod; offerId?: string; delivery: DeliveryInfo },
  ): Promise<CheckoutResult & { quote: EscrowQuote }> {
    this.requireVerified(user);
    if (!(await this.settings.section('escrow')).enabled) {
      throw Errors.badRequest('Escrow purchases are paused right now. Add the item to your cart instead.', 'ESCROW_DISABLED');
    }
    const quantity = input.quantity ?? 1;
    const product = await this.products.findPublic(input.productId);
    if (product.sellerId === user.id) throw Errors.forbidden('You cannot buy your own listing.', 'OWN_LISTING');
    const { price, offerId } = await this.agreedPrice(user, product, input.offerId);
    const quote = priceEscrow(price, quantity, await pricingSettings(this.settings));
    const window = await this.expiryWindow();
    const checkoutId = `chk_${randomBytes(8).toString('hex')}`;

    const orderId = await this.db.transaction(async (tx) => {
      const [reserved] = await this.reserveAll(tx, [{ productId: product.id, quantity }]);
      const [order] = await tx
        .insert(orders)
        .values({
          reference: orderReference(),
          checkoutId,
          buyerId: user.id,
          sellerId: reserved.sellerId,
          kind: 'escrow',
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
          paymentMethod: input.method,
          status: 'awaiting-payment',
          offerId: offerId ?? null,
          expiresAt: window.expiresAt,
        })
        .returning({ id: orders.id });
      await this.insertItems(tx, order.id, [{ product: reserved, quantity, price }]);
      return order.id;
    });
    const result = await this.charge(user, [orderId], checkoutId, quote.total, input.method, window.minutes);
    return { ...result, quote };
  }

  private async insertItems(tx: Transaction, orderId: string, lines: { product: Product; quantity: number; price: number }[]): Promise<void> {
    await tx.insert(orderItems).values(
      lines.map((line, position) => ({
        orderId,
        position,
        productId: line.product.id,
        title: line.product.title,
        sku: skuFor(line.product.id),
        quantity: line.quantity,
        price: line.price,
        image: line.product.images[0] ?? '',
        condition: line.product.condition,
      })),
    );
  }
}
