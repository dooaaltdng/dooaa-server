import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, sum, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import type { EscrowPhase, OrderActor, OrderKind, OrderStatus, OtpChannel, Settlement } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { addDays, addHours, DAY } from '../../common/util/dates';
import { escrowReference } from '../../common/util/ids';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { containsText, InjectDb, type Database } from '../../database/database';
import { orderItems, orders, products, type EscrowHistoryEntry, type TimelineEntry } from '../../database/schema';
import { OtpService, type IssuedOtp } from '../otp/otp.service';
import { PaymentsService } from '../payments/payments.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import { ACCOUNT_EVENTS, type AccountClosing } from '../users/account.events';
import type { User } from '../users/user.model';
import { UsersService } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import type { EscrowState } from './dto/orders.dto';
import { toOrder, type Order, type OrderRow } from './order.model';
import { HELD_PHASES, phasesLeadingTo } from './order-state';
import { toBuyerOrderView, toSellerOrderView, type BuyerOrderView, type SellerOrderView } from './order.presenter';

export const ORDER_EVENTS = { updated: 'order.updated' } as const;

export type OrderEventName =
  | 'paid'
  | 'confirmed'
  | 'shipped'
  | 'delivered'
  | 'received'
  | 'released'
  | 'cancelled'
  | 'cancellation-requested'
  | 'refund-processed'
  | 'refund-failed'
  | 'disputed'
  | 'dispute-closed'
  | 'reversed';

export type OrderUpdated = {
  order: Order;
  event: OrderEventName;
  actor: OrderActor;
  note?: string;
};

export type Actor = { kind: OrderActor; id?: string; name: string };

type OrderPatch = PgUpdateSetSource<typeof orders>;

const ACTIVE_FOR_CLOSURE: OrderStatus[] = ['pending', 'confirmed', 'shipped'];

function entry(code: string, label: string, description: string, at = new Date()): TimelineEntry {
  return { code, label, description, at: at.toISOString() };
}

type OrderListQuery = { status?: OrderStatus; q?: string; kind?: OrderKind; escrow?: EscrowState };

/** Escrow phases behind each money state on the seller's Escrow Payments tab. */
const ESCROW_STATE_PHASES: Record<EscrowState, EscrowPhase[]> = {
  held: ['funded', 'shipped', 'inspection', 'disputed'],
  released: ['released'],
  refunded: ['refunded'],
};

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly users: UsersService,
    private readonly products: ProductsService,
    private readonly payments: PaymentsService,
    private readonly wallet: WalletService,
    private readonly settings: SettingsService,
    private readonly otp: OtpService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<AccountClosing>(ACCOUNT_EVENTS.closing, (event) => this.vetoClosure(event.userId));
  }

  private async deliveryEstimateDays(): Promise<number> {
    return (await this.settings.section('commerce')).deliveryEstimateDays;
  }

  /* --- Loading ------------------------------------------------------------------ */

  /** Orders with their items, in the order the rows were given. */
  async withItems(rows: OrderRow[]): Promise<Order[]> {
    if (!rows.length) return [];
    const items = await this.db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((row) => row.id),
        ),
      );
    const byOrder = new Map<string, (typeof items)[number][]>();
    for (const item of items) byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), item]);
    return rows.map((row) => toOrder(row, byOrder.get(row.id) ?? []));
  }

  private async one(where: SQL | undefined): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(where).limit(1);
    return row ? (await this.withItems([row]))[0] : null;
  }

  async findById(id: string): Promise<Order | null> {
    return isUuid(id) ? this.one(eq(orders.id, id)) : null;
  }

  async findMany(ids: string[]): Promise<Order[]> {
    const valid = ids.filter(isUuid);
    if (!valid.length) return [];
    return this.withItems(await this.db.select().from(orders).where(inArray(orders.id, valid)).orderBy(orders.createdAt));
  }

  /* --- Lookups ------------------------------------------------------------------ */

  /** Routes accept the order id or the "123-47128390" reference (with or without "#"). */
  private idFilter(idOrReference: string): SQL {
    const reference = idOrReference.replace(/^#/, '');
    return isUuid(reference) ? eq(orders.id, reference) : eq(orders.reference, reference);
  }

  private async forBuyer(user: AuthUser, idOrReference: string): Promise<Order> {
    const order = await this.one(and(this.idFilter(idOrReference), eq(orders.buyerId, user.id)));
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    return order;
  }

  private async forSeller(user: AuthUser, idOrReference: string): Promise<Order> {
    const order = await this.one(and(this.idFilter(idOrReference), eq(orders.sellerId, user.id), ne(orders.status, 'awaiting-payment')));
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    return order;
  }

  private async people(ids: string[]): Promise<Map<string, User>> {
    const rows = await this.users.findByIds(ids);
    return new Map(rows.map((row) => [row.id, row]));
  }

  async buyerViews(rows: Order[]): Promise<BuyerOrderView[]> {
    const [people, days] = await Promise.all([this.people(rows.map((row) => row.sellerId)), this.deliveryEstimateDays()]);
    return rows.map((row) => toBuyerOrderView(row, people.get(row.sellerId) ?? null, days));
  }

  async sellerViews(rows: Order[]): Promise<SellerOrderView[]> {
    const [people, days] = await Promise.all([this.people(rows.flatMap((row) => [row.buyerId, row.sellerId])), this.deliveryEstimateDays()]);
    return rows.map((row) => toSellerOrderView(row, people.get(row.buyerId) ?? null, people.get(row.sellerId) ?? null, days));
  }

  /* --- Reads ----------------------------------------------------------------------- */

  private listFilter(owner: 'buyer' | 'seller', userId: string, query: OrderListQuery): SQL {
    const conditions: SQL[] = [eq(owner === 'buyer' ? orders.buyerId : orders.sellerId, userId)];
    conditions.push(query.status ? eq(orders.status, query.status) : ne(orders.status, 'awaiting-payment'));
    if (query.kind) conditions.push(eq(orders.kind, query.kind));
    if (query.escrow) conditions.push(inArray(orders.escrowPhase, ESCROW_STATE_PHASES[query.escrow]));
    const term = query.q?.trim().replace(/^#/, '');
    if (term) {
      conditions.push(
        or(
          containsText(orders.reference, term),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(orderItems)
              .where(and(eq(orderItems.orderId, orders.id), containsText(orderItems.title, term))),
          ),
        )!,
      );
    }
    return and(...conditions)!;
  }

  private async pageOf(where: SQL, page: number | undefined, limit: number): Promise<{ rows: Order[]; total: number; window: ReturnType<typeof pageWindow> }> {
    const [{ total }] = await this.db.select({ total: count() }).from(orders).where(where);
    const window = pageWindow(total, page, limit);
    const rows = await this.db.select().from(orders).where(where).orderBy(desc(orders.createdAt), desc(orders.id)).offset(window.skip).limit(window.size);
    return { rows: await this.withItems(rows), total, window };
  }

  async list(user: AuthUser, query: OrderListQuery & { page?: number; limit?: number }): Promise<Page<BuyerOrderView>> {
    const { rows, total, window } = await this.pageOf(this.listFilter('buyer', user.id, query), query.page, query.limit ?? 10);
    return toPage(await this.buyerViews(rows), total, window);
  }

  async recent(user: AuthUser, limit = 4): Promise<BuyerOrderView[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.buyerId, user.id), ne(orders.status, 'awaiting-payment')))
      .orderBy(desc(orders.createdAt))
      .limit(Math.min(limit, 20));
    return this.buyerViews(await this.withItems(rows));
  }

  async get(user: AuthUser, idOrReference: string): Promise<BuyerOrderView> {
    return (await this.buyerViews([await this.forBuyer(user, idOrReference)]))[0];
  }

  async countForBuyer(userId: string): Promise<number> {
    return this.countOrders(and(eq(orders.buyerId, userId), ne(orders.status, 'awaiting-payment')));
  }

  async sellerList(user: AuthUser, query: OrderListQuery & { page?: number; limit?: number }): Promise<Page<SellerOrderView>> {
    const { rows, total, window } = await this.pageOf(this.listFilter('seller', user.id, query), query.page, query.limit ?? 10);
    return toPage(await this.sellerViews(rows), total, window);
  }

  async sellerRecent(user: AuthUser, limit = 6): Promise<SellerOrderView[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.sellerId, user.id), ne(orders.status, 'awaiting-payment')))
      .orderBy(desc(orders.createdAt))
      .limit(Math.min(limit, 20));
    return this.sellerViews(await this.withItems(rows));
  }

  async sellerGet(user: AuthUser, idOrReference: string): Promise<SellerOrderView> {
    return (await this.sellerViews([await this.forSeller(user, idOrReference)]))[0];
  }

  /**
   * The Escrow Payments tiles: what buyers have paid that is still held, what
   * was released to the seller and what went back to buyers, over every sale.
   */
  async sellerEscrowSummary(user: AuthUser): Promise<{ held: number; released: number; refunded: number; orders: number }> {
    const rows = await this.db
      .select({ phase: orders.escrowPhase, total: sum(orders.total).mapWith(Number), count: count() })
      .from(orders)
      .where(and(eq(orders.sellerId, user.id), isNotNull(orders.escrowPhase)))
      .groupBy(orders.escrowPhase);
    const total = (state: EscrowState) =>
      Math.round(rows.filter((row) => row.phase && ESCROW_STATE_PHASES[state].includes(row.phase)).reduce((running, row) => running + row.total, 0) * 100) / 100;
    return { held: total('held'), released: total('released'), refunded: total('refunded'), orders: rows.reduce((running, row) => running + row.count, 0) };
  }

  /* --- The atomic step every transition goes through --------------------------------- */

  /**
   * Applies an update only if the order is still where the caller thinks it
   * is, in one statement. Two people pressing buttons at once cannot both win.
   */
  private async transition(
    id: string,
    condition: SQL | undefined,
    set: OrderPatch,
    append: { timeline?: TimelineEntry[]; history?: EscrowHistoryEntry[] },
    verb: string,
  ): Promise<Order> {
    const patch: OrderPatch = { ...set };
    if (append.timeline?.length) patch.timeline = appendJson(orders.timeline, append.timeline);
    if (append.history?.length) patch.escrowHistory = appendJson(orders.escrowHistory, append.history);
    const [row] = await this.db
      .update(orders)
      .set(patch)
      .where(and(eq(orders.id, id), condition))
      .returning();
    if (row) return (await this.withItems([row]))[0];
    const current = await this.findById(id);
    if (!current) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    throw Errors.conflict(`This order is ${current.status.replace('-', ' ')} and cannot be ${verb} now.`, 'ORDER_STATE_CHANGED', {
      status: current.status,
      escrowPhase: current.escrow?.phase ?? null,
    });
  }

  private announce(order: Order, event: OrderEventName, actor: OrderActor, note?: string): void {
    this.events.publish<OrderUpdated>(ORDER_EVENTS.updated, { order, event, actor, note });
  }

  private historyEntry(action: string, by: Actor, note?: string): EscrowHistoryEntry {
    return { action, by: by.id ? `${by.kind}:${by.id}` : by.kind, at: new Date().toISOString(), ...(note ? { note } : {}) };
  }

  /* --- Payment outcome --------------------------------------------------------------- */

  /** The provider confirmed the charge: every order it paid for is funded and handed to its seller. */
  async fund(
    orderIds: string[],
    payment: { provider: string; paidAt?: Date | null; card?: { brand?: string | null; last4?: string | null } | null; channel?: string | null },
  ): Promise<Order[]> {
    const commerce = await this.settings.section('commerce');
    const funded: Order[] = [];
    for (const orderId of orderIds) {
      const now = new Date();
      const [row] = await this.db
        .update(orders)
        .set({
          status: 'pending',
          paymentStatus: 'paid',
          paymentPaidAt: payment.paidAt ?? now,
          paymentBrand: payment.card?.brand ?? null,
          paymentLast4: payment.card?.last4 ?? null,
          paymentChannel: payment.channel ?? null,
          shipBy: addHours(now, commerce.shipWithinHours),
          escrowReference: escrowReference(),
          escrowPhase: 'funded',
          escrowStatus: 'pending',
          escrowSettlement: null,
          escrowPhaseBeforeDispute: null,
          escrowFundedAt: now,
          escrowHistory: [{ action: 'funded', by: payment.provider, at: now.toISOString() }],
          expiresAt: null,
          timeline: appendJson(orders.timeline, [
            entry('placed', 'Order placed', 'We received your order.', now),
            entry('funded', 'Payment secured in escrow', 'Your payment is held safely until the item is delivered.', now),
          ]),
        })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'awaiting-payment')))
        .returning();
      if (!row) continue; // Already funded (webhook and verify both arrived).
      const [order] = await this.withItems([row]);
      await this.wallet.onFunded(order);
      for (const item of order.items) await this.products.recordSale(item.productId, item.quantity, item.price * item.quantity, now);
      await this.users.incrementStats(order.buyerId, { purchases: 1 });
      await this.users.incrementStats(order.sellerId, { sales: 1 });
      funded.push(order);
      this.announce(order, 'paid', 'system');
    }
    return funded;
  }

  /** The charge failed or lapsed: release the stock it was holding and close the orders. */
  async abandon(orderIds: string[], reason: string): Promise<void> {
    for (const orderId of orderIds) {
      const [row] = await this.db
        .update(orders)
        .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'system', cancellationReason: reason, paymentStatus: 'failed', expiresAt: null })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'awaiting-payment')))
        .returning({ id: orders.id });
      if (!row) continue;
      const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      for (const item of items) await this.products.releaseStock(item.productId, item.quantity);
    }
  }

  /** The provider finished (or failed) a refund for an order. */
  async applyRefundOutcome(orderId: string, refund: { status: 'pending' | 'processed' | 'failed'; processedAt?: Date | null; failureReason?: string | null }): Promise<void> {
    const [row] = await this.db
      .update(orders)
      .set({
        refundStatus: refund.status,
        refundProcessedAt: refund.processedAt ?? new Date(),
        refundFailureReason: refund.failureReason ?? null,
        ...(refund.status === 'processed'
          ? { timeline: appendJson(orders.timeline, [entry('refunded', 'Refund completed', 'Your money is back on your original payment method.')]) }
          : {}),
      })
      .where(and(eq(orders.id, orderId), eq(orders.refundStatus, 'pending')))
      .returning();
    if (!row) return;
    const [order] = await this.withItems([row]);
    this.announce(order, refund.status === 'processed' ? 'refund-processed' : 'refund-failed', 'system');
  }

  /* --- Money moves ------------------------------------------------------------------ */

  /**
   * Instructs the provider to return the buyer's payment for this order and
   * records the request. A provider failure leaves the refund marked
   * failed for the console to retry; the order is cancelled either way.
   */
  private async requestRefund(order: Order, reason: string): Promise<void> {
    const refund = await this.payments.refundOrder({ orderId: order.id, amount: order.total, reason });
    await this.db
      .update(orders)
      .set({
        refundStatus: refund.status,
        refundAmount: refund.amount,
        refundReference: refund.refundReference,
        refundRequestedAt: refund.requestedAt,
        refundProcessedAt: refund.processedAt,
        refundFailureReason: refund.failureReason,
      })
      .where(eq(orders.id, order.id));
  }

  /** Releases held funds to the seller. */
  async releaseEscrow(
    order: Order,
    by: Actor,
    settlement: Extract<Settlement, 'released' | 'force-released'> = 'released',
    note?: string,
    options: { fromDispute?: boolean } = {},
  ): Promise<Order> {
    const now = new Date();
    const fromPhases: EscrowPhase[] =
      settlement === 'force-released' || options.fromDispute ? ['disputed'] : phasesLeadingTo('released').filter((phase) => phase !== 'disputed');
    const deliveredNow = order.status !== 'delivered';
    const released = await this.transition(
      order.id,
      and(inArray(orders.escrowPhase, fromPhases), inArray(orders.status, ['pending', 'confirmed', 'shipped', 'delivered'])),
      {
        status: 'delivered',
        completedAt: now,
        ...(deliveredNow ? { deliveredAt: order.deliveredAt ?? now } : {}),
        escrowPhase: 'released',
        escrowStatus: 'completed',
        escrowSettlement: settlement,
        escrowReleasedAt: now,
        escrowSettledBy: by.id ? `${by.kind}:${by.id}` : by.kind,
        escrowSettledAt: now,
        ...(order.escrow?.receivedAt ? {} : { escrowReceivedAt: now }),
      },
      {
        history: [this.historyEntry(settlement, by, note)],
        timeline: [
          entry('released', 'Order completed', by.kind === 'buyer' ? 'You confirmed the item and payment was released to the seller.' : 'Payment was released to the seller.', now),
        ],
      },
      'released',
    );
    await this.wallet.onReleased(released);
    this.announce(released, 'released', by.kind, note);
    return released;
  }

  /** Cancels a paid order and refunds the buyer in full. */
  async refundEscrow(order: Order, by: Actor, reason: string, allowFrom: EscrowPhase[] = ['funded', 'shipped', 'inspection']): Promise<Order> {
    const now = new Date();
    const cancelled = await this.transition(
      order.id,
      inArray(orders.escrowPhase, allowFrom),
      {
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: by.kind,
        cancellationReason: reason,
        escrowPhase: 'refunded',
        escrowStatus: 'completed',
        escrowSettlement: 'refunded',
        escrowRefundedAt: now,
        escrowSettledBy: by.id ? `${by.kind}:${by.id}` : by.kind,
        escrowSettledAt: now,
        cancellationRequestReason: null,
        cancellationRequestedAt: null,
      },
      {
        history: [this.historyEntry('refunded', by, reason)],
        timeline: [entry('cancelled', 'Order cancelled', `${reason} A full refund has been requested to your original payment method.`, now)],
      },
      'cancelled',
    );
    await this.requestRefund(cancelled, reason);
    await this.wallet.onCancelled(cancelled);
    // Stock only returns if the item never left the seller.
    if (!cancelled.escrow?.shippedAt) {
      for (const item of cancelled.items) await this.products.releaseStock(item.productId, item.quantity);
    }
    for (const item of cancelled.items) await this.products.reverseSale(item.productId, item.quantity, item.price * item.quantity);
    const latest = (await this.findById(cancelled.id))!;
    this.announce(latest, 'cancelled', by.kind, reason);
    return latest;
  }

  /* --- Buyer actions -------------------------------------------------------------- */

  async cancelByBuyer(user: AuthUser, idOrReference: string, reason: string): Promise<BuyerOrderView> {
    const order = await this.forBuyer(user, idOrReference);
    const overdue = order.status === 'confirmed' && order.shipBy && order.shipBy.getTime() < Date.now();
    if (order.status !== 'pending' && !overdue) {
      throw Errors.conflict(
        order.status === 'confirmed' ? 'The seller has confirmed this order. Ask them to cancel it instead.' : 'This order can no longer be cancelled.',
        'ORDER_STATE_CHANGED',
        { status: order.status },
      );
    }
    const cancelled = await this.refundEscrow(order, { kind: 'buyer', id: user.id, name: user.firstName }, reason, ['funded']);
    return (await this.buyerViews([cancelled]))[0];
  }

  /** After confirmation the buyer can only ask; the seller decides. */
  async requestCancellation(user: AuthUser, idOrReference: string, reason: string): Promise<BuyerOrderView> {
    const order = await this.forBuyer(user, idOrReference);
    const updated = await this.transition(
      order.id,
      and(eq(orders.status, 'confirmed'), isNull(orders.cancellationRequestedAt)),
      { cancellationRequestReason: reason, cancellationRequestedAt: new Date() },
      { timeline: [entry('cancellation-requested', 'Cancellation requested', reason)] },
      'changed',
    );
    this.announce(updated, 'cancellation-requested', 'buyer', reason);
    return (await this.buyerViews([updated]))[0];
  }

  /** "Item marked as received" — starts the inspection window. */
  async markReceived(user: AuthUser, idOrReference: string): Promise<BuyerOrderView> {
    const order = await this.forBuyer(user, idOrReference);
    const updated = await this.startInspection(order, { kind: 'buyer', id: user.id, name: user.firstName });
    return (await this.buyerViews([updated]))[0];
  }

  private async startInspection(order: Order, by: Actor, proofUrl?: string, note?: string): Promise<Order> {
    const settings = await this.settings.get();
    const now = new Date();
    const fromStatuses: OrderStatus[] = by.kind === 'seller' ? ['confirmed', 'shipped'] : ['shipped'];
    const updated = await this.transition(
      order.id,
      and(inArray(orders.status, fromStatuses), inArray(orders.escrowPhase, ['funded', 'shipped'])),
      {
        status: 'delivered',
        deliveredAt: now,
        returnBy: addDays(now, settings.disputes.returnWindowDays),
        escrowPhase: 'inspection',
        escrowReceivedAt: now,
        escrowInspectionEndsAt: addDays(now, settings.escrow.autoReleaseDays),
        ...(proofUrl ? { shipmentProofUrl: proofUrl } : {}),
      },
      {
        history: [this.historyEntry('received', by, note)],
        timeline: [
          entry(
            'delivered',
            'Delivered',
            by.kind === 'buyer' ? 'You marked the item as received. The inspection period has started.' : 'The seller marked the order as delivered. The inspection period has started.',
            now,
          ),
        ],
      },
      'marked as delivered',
    );
    this.announce(updated, by.kind === 'buyer' ? 'received' : 'delivered', by.kind, note);
    return updated;
  }

  /** "Verify your purchase": a code to confirm releasing the money. */
  async sendReleaseCode(user: AuthUser, idOrReference: string, channel: OtpChannel = 'email'): Promise<IssuedOtp> {
    const order = await this.forBuyer(user, idOrReference);
    if (!order.escrow || !['shipped', 'inspection'].includes(order.escrow.phase)) {
      throw Errors.conflict('There is nothing to release on this order right now.', 'ORDER_STATE_CHANGED', { status: order.status });
    }
    const to = channel === 'email' ? user.email : user.phone;
    if (!to) throw Errors.badRequest('There is no phone number on this account. Use email instead.', 'NO_PHONE');
    return this.otp.issue({ key: `user:${user.id}`, purpose: 'confirm-release', channel, to, userId: user.id, context: order.id });
  }

  /** The buyer confirms the item is as described: payment goes to the seller. */
  async release(user: AuthUser, idOrReference: string, code: string): Promise<BuyerOrderView> {
    const order = await this.forBuyer(user, idOrReference);
    if (!order.escrow || !['shipped', 'inspection'].includes(order.escrow.phase)) {
      throw Errors.conflict('There is nothing to release on this order right now.', 'ORDER_STATE_CHANGED', { status: order.status });
    }
    await this.otp.verify({ key: `user:${user.id}`, purpose: 'confirm-release', code, context: order.id });
    const released = await this.releaseEscrow(order, { kind: 'buyer', id: user.id, name: user.firstName });
    return (await this.buyerViews([released]))[0];
  }

  /* --- Seller actions ------------------------------------------------------------- */

  async confirm(user: AuthUser, idOrReference: string): Promise<SellerOrderView> {
    const order = await this.forSeller(user, idOrReference);
    const updated = await this.transition(
      order.id,
      eq(orders.status, 'pending'),
      { status: 'confirmed', confirmedAt: new Date() },
      { timeline: [entry('confirmed', 'Order confirmed', 'The seller confirmed your order and is preparing it for dispatch.')] },
      'confirmed',
    );
    this.announce(updated, 'confirmed', 'seller');
    return (await this.sellerViews([updated]))[0];
  }

  async ship(user: AuthUser, idOrReference: string, input: { carrier: string; trackingNumber: string; proofUrl?: string; note?: string }): Promise<SellerOrderView> {
    const order = await this.forSeller(user, idOrReference);
    const now = new Date();
    const updated = await this.transition(
      order.id,
      and(inArray(orders.status, ['pending', 'confirmed']), eq(orders.escrowPhase, 'funded')),
      {
        status: 'shipped',
        confirmedAt: order.confirmedAt ?? now,
        shipmentCarrier: input.carrier,
        shipmentTrackingNumber: input.trackingNumber,
        shipmentProofUrl: input.proofUrl ?? null,
        shipmentNote: input.note ?? null,
        shippedAt: now,
        escrowPhase: 'shipped',
        escrowShippedAt: now,
        cancellationRequestReason: null,
        cancellationRequestedAt: null,
      },
      {
        history: [this.historyEntry('shipped', { kind: 'seller', id: user.id, name: user.firstName })],
        timeline: [entry('shipped', 'Shipped', `Package handed to ${input.carrier}. Tracking number ${input.trackingNumber}.`, now)],
      },
      'shipped',
    );
    this.announce(updated, 'shipped', 'seller');
    return (await this.sellerViews([updated]))[0];
  }

  /** A handover in person (meetup) or proof of delivery from the courier. */
  async deliver(user: AuthUser, idOrReference: string, input: { proofUrl?: string; note?: string }): Promise<SellerOrderView> {
    const order = await this.forSeller(user, idOrReference);
    const updated = await this.startInspection(order, { kind: 'seller', id: user.id, name: user.firstName }, input.proofUrl, input.note);
    return (await this.sellerViews([updated]))[0];
  }

  async cancelBySeller(user: AuthUser, idOrReference: string, reason: string): Promise<SellerOrderView> {
    const order = await this.forSeller(user, idOrReference);
    if (!['pending', 'confirmed'].includes(order.status)) {
      throw Errors.conflict('An order that has shipped cannot be cancelled. Open a conversation with the buyer instead.', 'ORDER_STATE_CHANGED', { status: order.status });
    }
    const cancelled = await this.refundEscrow(order, { kind: 'seller', id: user.id, name: user.firstName }, reason, ['funded']);
    return (await this.sellerViews([cancelled]))[0];
  }

  /* --- Disputes ------------------------------------------------------------------- */

  /** Freezes the money while a dispute is open. */
  async markDisputed(orderId: string, disputeId: string, by: Actor, reason: string): Promise<Order> {
    const order = await this.findById(orderId);
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    const updated = await this.transition(
      orderId,
      and(inArray(orders.escrowPhase, ['shipped', 'inspection']), isNull(orders.disputeId)),
      {
        disputeId,
        escrowPhaseBeforeDispute: order.escrow?.phase ?? null,
        escrowPhase: 'disputed',
        escrowStatus: 'dispute',
        escrowDisputedAt: new Date(),
      },
      {
        history: [this.historyEntry('disputed', by, reason)],
        timeline: [entry('disputed', 'Dispute opened', 'Payment is on hold while DOOAA reviews the dispute.')],
      },
      'disputed',
    );
    this.announce(updated, 'disputed', by.kind, reason);
    return updated;
  }

  /** DOOAA reopened a dispute it had closed without action: the payment goes back on hold under it. */
  async reopenDispute(orderId: string, disputeId: string, by: Actor, reason: string): Promise<Order> {
    const order = await this.findById(orderId);
    if (!order?.escrow) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    const updated = await this.transition(
      orderId,
      and(eq(orders.disputeId, disputeId), inArray(orders.escrowPhase, ['shipped', 'inspection'])),
      {
        escrowPhaseBeforeDispute: order.escrow.phase,
        escrowPhase: 'disputed',
        escrowStatus: 'dispute',
        escrowDisputedAt: new Date(),
      },
      {
        history: [this.historyEntry('disputed', by, reason)],
        timeline: [entry('disputed', 'Dispute reopened', 'Payment is on hold again while DOOAA takes another look.')],
      },
      'disputed',
    );
    this.announce(updated, 'disputed', by.kind, reason);
    return updated;
  }

  /** A dispute closed without a ruling: the money goes back to where it was. */
  async restoreFromDispute(orderId: string, by: Actor, note?: string): Promise<Order> {
    const order = await this.findById(orderId);
    if (!order?.escrow || order.escrow.phase !== 'disputed') {
      throw Errors.conflict('This order is not under dispute.', 'ORDER_STATE_CHANGED');
    }
    const back = order.escrow.phaseBeforeDispute ?? 'inspection';
    const settings = await this.settings.get();
    const updated = await this.transition(
      orderId,
      eq(orders.escrowPhase, 'disputed'),
      {
        escrowPhase: back,
        escrowStatus: 'pending',
        escrowPhaseBeforeDispute: null,
        // A fresh inspection window, so the auto-release does not fire the moment the dispute closes.
        ...(back === 'inspection' ? { escrowInspectionEndsAt: addDays(new Date(), settings.escrow.autoReleaseDays) } : {}),
      },
      {
        history: [this.historyEntry('dispute-closed', by, note)],
        timeline: [entry('dispute-closed', 'Dispute closed', note ?? 'The dispute was closed and the order continues.')],
      },
      'restored',
    );
    this.announce(updated, 'dispute-closed', by.kind, note);
    return updated;
  }

  /** Reverses a release: the funds go back on hold under a dispute. */
  async reverseRelease(order: Order, by: Actor, note?: string): Promise<Order> {
    if (order.escrow?.settlement === 'refunded') {
      throw Errors.conflict('The refund has already been paid back to the buyer and cannot be reversed from the console.', 'REFUND_IRREVERSIBLE');
    }
    // Take the money back off the seller's balance first; refuse if it has been withdrawn.
    await this.wallet.onReversed(order);
    const now = new Date();
    const updated = await this.transition(
      order.id,
      eq(orders.escrowPhase, 'released'),
      {
        escrowPhase: 'disputed',
        escrowStatus: 'dispute',
        escrowSettlement: 'reversed',
        escrowPhaseBeforeDispute: 'inspection',
        escrowDisputedAt: now,
        escrowSettledBy: by.id ? `${by.kind}:${by.id}` : by.kind,
        escrowSettledAt: now,
        completedAt: null,
      },
      {
        history: [this.historyEntry('reversed', by, note)],
        timeline: [entry('reversed', 'Release reversed', 'DOOAA put the payment back on hold for review.')],
      },
      'reversed',
    );
    this.announce(updated, 'reversed', by.kind, note);
    return updated;
  }

  /* --- Background work ---------------------------------------------------------- */

  /** Inspection windows that have run out release to the seller. */
  async autoRelease(now = new Date()): Promise<number> {
    const due = await this.withItems(
      await this.db
        .select()
        .from(orders)
        .where(and(eq(orders.escrowPhase, 'inspection'), lte(orders.escrowInspectionEndsAt, now)))
        .limit(200),
    );
    let released = 0;
    for (const order of due) {
      try {
        await this.releaseEscrow(order, { kind: 'system', name: 'Auto-release' }, 'released', 'Inspection period ended');
        released += 1;
      } catch (error) {
        this.logger.warn(`Auto-release skipped ${order.reference}: ${(error as Error).message}`);
      }
    }
    return released;
  }

  /** Orders the seller never shipped are cancelled and refunded after a grace period. */
  async cancelOverdue(now = new Date(), graceHours = 72): Promise<number> {
    const cutoff = new Date(now.getTime() - graceHours * 3_600_000);
    const due = await this.withItems(
      await this.db
        .select()
        .from(orders)
        .where(and(inArray(orders.status, ['pending', 'confirmed']), eq(orders.escrowPhase, 'funded'), lte(orders.shipBy, cutoff)))
        .limit(200),
    );
    let cancelled = 0;
    for (const order of due) {
      try {
        await this.refundEscrow(order, { kind: 'system', name: 'Dispatch deadline' }, 'The seller did not ship the order in time.', ['funded']);
        cancelled += 1;
      } catch (error) {
        this.logger.warn(`Overdue cancel skipped ${order.reference}: ${(error as Error).message}`);
      }
    }
    return cancelled;
  }

  /* --- Account closure ----------------------------------------------------------- */

  private async vetoClosure(userId: string): Promise<void> {
    const open = await this.countOrders(
      and(
        or(eq(orders.buyerId, userId), eq(orders.sellerId, userId)),
        or(inArray(orders.status, ACTIVE_FOR_CLOSURE), inArray(orders.escrowPhase, [...HELD_PHASES, 'disputed'])),
      ),
    );
    if (open > 0) {
      throw Errors.conflict('You have orders in progress. Close your account once they are completed.', 'OPEN_ORDERS', { open });
    }
    if (await this.wallet.hasOpenBalance(userId)) {
      throw Errors.conflict('You still have earnings on DOOAA. Withdraw your balance before closing your account.', 'OPEN_BALANCE');
    }
  }

  /* --- Dashboards -------------------------------------------------------------- */

  private async countOrders(where: SQL | undefined): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(orders).where(where);
    return row.total;
  }

  private async countProducts(where: SQL | undefined): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(products).where(where);
    return row.total;
  }

  /** The seller dashboard's headline tiles, with week-on-week change. */
  async sellerSummary(user: AuthUser) {
    const now = Date.now();
    const thisWeek = new Date(now - 7 * DAY);
    const lastWeek = new Date(now - 14 * DAY);
    const mine = eq(orders.sellerId, user.id);
    const listed = and(eq(products.sellerId, user.id), isNull(products.deletedAt));
    const [revenue, totalOrders, pendingOrders, activeProducts, ordersThis, ordersLast, revenueThis, revenueLast, listedThis, listedLast, pendingThis, pendingLast] =
      await Promise.all([
        this.sumReleased(user.id),
        this.countOrders(and(mine, ne(orders.status, 'awaiting-payment'), eq(orders.paymentStatus, 'paid'))),
        this.countOrders(and(mine, inArray(orders.status, ['pending', 'confirmed']))),
        this.countProducts(and(listed, eq(products.status, 'active'))),
        this.countOrders(and(mine, eq(orders.paymentStatus, 'paid'), gte(orders.paymentPaidAt, thisWeek))),
        this.countOrders(and(mine, eq(orders.paymentStatus, 'paid'), gte(orders.paymentPaidAt, lastWeek), lt(orders.paymentPaidAt, thisWeek))),
        this.sumReleased(user.id, thisWeek, new Date(now)),
        this.sumReleased(user.id, lastWeek, thisWeek),
        this.countProducts(and(listed, gte(products.publishedAt, thisWeek))),
        this.countProducts(and(listed, gte(products.publishedAt, lastWeek), lt(products.publishedAt, thisWeek))),
        this.countOrders(and(mine, inArray(orders.status, ['pending', 'confirmed']), gte(orders.createdAt, thisWeek))),
        this.countOrders(and(mine, inArray(orders.status, ['pending', 'confirmed']), gte(orders.createdAt, lastWeek), lt(orders.createdAt, thisWeek))),
      ]);
    const change = (current: number, previous: number) => (previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 1000) / 10);
    return {
      revenue: Math.round(revenue * 100) / 100,
      totalOrders,
      activeProducts,
      pendingOrders,
      trends: {
        revenue: change(revenueThis, revenueLast),
        totalOrders: change(ordersThis, ordersLast),
        activeProducts: change(listedThis, listedLast),
        pendingOrders: change(pendingThis, pendingLast),
      },
    };
  }

  /** What has been released to the seller, overall or within a window. */
  private async sumReleased(sellerId: string, from?: Date, to?: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(orders.sellerEarning).mapWith(Number) })
      .from(orders)
      .where(
        and(
          eq(orders.sellerId, sellerId),
          eq(orders.escrowPhase, 'released'),
          from ? gte(orders.escrowReleasedAt, from) : undefined,
          to ? lt(orders.escrowReleasedAt, to) : undefined,
        ),
      );
    return row?.total ?? 0;
  }
}
