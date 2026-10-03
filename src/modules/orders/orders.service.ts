import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import type { EscrowPhase, OrderKind, OrderStatus, Settlement } from '../../common/domain';
import { addDays, addHours, DAY } from '../../common/util/dates';
import { escrowReference } from '../../common/util/ids';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { containsRegex } from '../../common/util/text';
import { OtpService, type IssuedOtp } from '../otp/otp.service';
import type { OtpChannel } from '../otp/otp.schema';
import { PaymentsService } from '../payments/payments.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import { ACCOUNT_EVENTS, type AccountClosing } from '../users/account.events';
import { User } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import type { EscrowState } from './dto/orders.dto';
import { HELD_PHASES, phasesLeadingTo } from './order-state';
import { toBuyerOrderView, toSellerOrderView, type BuyerOrderView, type SellerOrderView } from './order.presenter';
import { Order, type TimelineEntry } from './schemas/order.schema';

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
  order: Lean<Order>;
  event: OrderEventName;
  actor: 'buyer' | 'seller' | 'system' | 'staff';
  note?: string;
};

export type Actor = { kind: 'buyer' | 'seller' | 'system' | 'staff'; id?: string; name: string };

const ACTIVE_FOR_CLOSURE: OrderStatus[] = ['pending', 'confirmed', 'shipped'];

function entry(code: string, label: string, description: string, at = new Date()): TimelineEntry {
  return { code, label, description, at };
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
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly userService: UsersService,
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

  get model(): Model<Order> {
    return this.orders;
  }

  private async deliveryEstimateDays(): Promise<number> {
    return (await this.settings.section('commerce')).deliveryEstimateDays;
  }

  /* --- Lookups ------------------------------------------------------------------ */

  /** Routes accept the Mongo id or the "123-47128390" reference (with or without "#"). */
  private idFilter(idOrReference: string): QueryFilter<Order> {
    const reference = idOrReference.replace(/^#/, '');
    return Types.ObjectId.isValid(reference) && /^[a-f\d]{24}$/i.test(reference) ? { _id: new Types.ObjectId(reference) } : { reference };
  }

  async findById(id: string | Types.ObjectId): Promise<Lean<Order> | null> {
    return this.orders.findById(id).lean<Lean<Order>>();
  }

  private async forBuyer(user: AuthUser, idOrReference: string): Promise<Lean<Order>> {
    const order = await this.orders.findOne({ ...this.idFilter(idOrReference), buyerId: new Types.ObjectId(user.id) }).lean<Lean<Order>>();
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    return order;
  }

  private async forSeller(user: AuthUser, idOrReference: string): Promise<Lean<Order>> {
    const order = await this.orders
      .findOne({ ...this.idFilter(idOrReference), sellerId: new Types.ObjectId(user.id), status: { $ne: 'awaiting-payment' } })
      .lean<Lean<Order>>();
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    return order;
  }

  private async people(ids: Types.ObjectId[]): Promise<Map<string, Lean<User>>> {
    const rows = await this.users.find({ _id: { $in: ids } }).lean<Lean<User>[]>();
    return new Map(rows.map((row) => [String(row._id), row]));
  }

  async buyerViews(rows: Lean<Order>[]): Promise<BuyerOrderView[]> {
    const [people, days] = await Promise.all([this.people(rows.map((row) => row.sellerId)), this.deliveryEstimateDays()]);
    return rows.map((row) => toBuyerOrderView(row, people.get(String(row.sellerId)) ?? null, days));
  }

  async sellerViews(rows: Lean<Order>[]): Promise<SellerOrderView[]> {
    const [people, days] = await Promise.all([this.people(rows.flatMap((row) => [row.buyerId, row.sellerId])), this.deliveryEstimateDays()]);
    return rows.map((row) => toSellerOrderView(row, people.get(String(row.buyerId)) ?? null, people.get(String(row.sellerId)) ?? null, days));
  }

  /* --- Reads ----------------------------------------------------------------------- */

  private listFilter(owner: 'buyerId' | 'sellerId', userId: string, query: OrderListQuery): QueryFilter<Order> {
    const filter: Record<string, unknown> = { [owner]: new Types.ObjectId(userId) };
    filter.status = query.status ?? { $ne: 'awaiting-payment' };
    if (query.kind) filter.kind = query.kind;
    if (query.escrow) filter['escrow.phase'] = { $in: ESCROW_STATE_PHASES[query.escrow] };
    if (query.q?.trim()) {
      const pattern = containsRegex(query.q.replace(/^#/, ''));
      filter.$or = [{ reference: pattern }, { 'items.title': pattern }];
    }
    return filter as QueryFilter<Order>;
  }

  async list(user: AuthUser, query: OrderListQuery & { page?: number; limit?: number }): Promise<Page<BuyerOrderView>> {
    const filter = this.listFilter('buyerId', user.id, query);
    const total = await this.orders.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 10);
    const rows = await this.orders.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Order>[]>();
    return toPage(await this.buyerViews(rows), total, window);
  }

  async recent(user: AuthUser, limit = 4): Promise<BuyerOrderView[]> {
    const rows = await this.orders
      .find({ buyerId: new Types.ObjectId(user.id), status: { $ne: 'awaiting-payment' } })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 20))
      .lean<Lean<Order>[]>();
    return this.buyerViews(rows);
  }

  async get(user: AuthUser, idOrReference: string): Promise<BuyerOrderView> {
    return (await this.buyerViews([await this.forBuyer(user, idOrReference)]))[0];
  }

  async countForBuyer(userId: string): Promise<number> {
    return this.orders.countDocuments({ buyerId: new Types.ObjectId(userId), status: { $ne: 'awaiting-payment' } });
  }

  async sellerList(user: AuthUser, query: OrderListQuery & { page?: number; limit?: number }): Promise<Page<SellerOrderView>> {
    const filter = this.listFilter('sellerId', user.id, query);
    const total = await this.orders.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 10);
    const rows = await this.orders.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Order>[]>();
    return toPage(await this.sellerViews(rows), total, window);
  }

  async sellerRecent(user: AuthUser, limit = 6): Promise<SellerOrderView[]> {
    const rows = await this.orders
      .find({ sellerId: new Types.ObjectId(user.id), status: { $ne: 'awaiting-payment' } })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 20))
      .lean<Lean<Order>[]>();
    return this.sellerViews(rows);
  }

  async sellerGet(user: AuthUser, idOrReference: string): Promise<SellerOrderView> {
    return (await this.sellerViews([await this.forSeller(user, idOrReference)]))[0];
  }

  /**
   * The Escrow Payments tiles: what buyers have paid that is still held, what
   * was released to the seller and what went back to buyers, over every sale.
   */
  async sellerEscrowSummary(user: AuthUser): Promise<{ held: number; released: number; refunded: number; orders: number }> {
    const rows = await this.orders.aggregate<{ _id: EscrowPhase; total: number; count: number }>([
      { $match: { sellerId: new Types.ObjectId(user.id), 'escrow.phase': { $exists: true, $ne: null } } },
      { $group: { _id: '$escrow.phase', total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]);
    const sum = (state: EscrowState) =>
      Math.round(rows.filter((row) => ESCROW_STATE_PHASES[state].includes(row._id)).reduce((total, row) => total + row.total, 0) * 100) / 100;
    return { held: sum('held'), released: sum('released'), refunded: sum('refunded'), orders: rows.reduce((count, row) => count + row.count, 0) };
  }

  /* --- The atomic step every transition goes through --------------------------------- */

  /**
   * Applies an update only if the order is still where the caller thinks it
   * is. Two people pressing buttons at once cannot both win.
   */
  private async transition(filter: QueryFilter<Order>, update: UpdateQuery<Order>, verb: string): Promise<Lean<Order>> {
    const updated = await this.orders.findOneAndUpdate(filter, update, { returnDocument: 'after' }).lean<Lean<Order>>();
    if (updated) return updated;
    const current = await this.orders.findOne({ _id: (filter as { _id?: unknown })._id }).lean<Lean<Order>>();
    if (!current) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    throw Errors.conflict(`This order is ${current.status.replace('-', ' ')} and cannot be ${verb} now.`, 'ORDER_STATE_CHANGED', {
      status: current.status,
      escrowPhase: current.escrow?.phase ?? null,
    });
  }

  private announce(order: Lean<Order>, event: OrderEventName, actor: OrderUpdated['actor'], note?: string): void {
    this.events.publish<OrderUpdated>(ORDER_EVENTS.updated, { order, event, actor, note });
  }

  private historyEntry(action: string, by: Actor, note?: string) {
    return { action, by: by.id ? `${by.kind}:${by.id}` : by.kind, at: new Date(), ...(note ? { note } : {}) };
  }

  /* --- Payment outcome --------------------------------------------------------------- */

  /** The provider confirmed the charge: every order it paid for is funded and handed to its seller. */
  async fund(orderIds: Types.ObjectId[], payment: { reference: string; provider: string; paidAt?: Date; card?: { brand?: string; last4?: string }; channel?: string }): Promise<Lean<Order>[]> {
    const commerce = await this.settings.section('commerce');
    const funded: Lean<Order>[] = [];
    for (const orderId of orderIds) {
      const now = new Date();
      const order = await this.orders
        .findOneAndUpdate(
          { _id: orderId, status: 'awaiting-payment' },
          {
            $set: {
              status: 'pending',
              'payment.status': 'paid',
              'payment.paidAt': payment.paidAt ?? now,
              'payment.brand': payment.card?.brand,
              'payment.last4': payment.card?.last4,
              'payment.channel': payment.channel,
              shipBy: addHours(now, commerce.shipWithinHours),
              escrow: {
                reference: escrowReference(),
                phase: 'funded',
                status: 'pending',
                settlement: null,
                phaseBeforeDispute: null,
                fundedAt: now,
                history: [{ action: 'funded', by: payment.provider, at: now }],
              },
            },
            $unset: { expiresAt: 1 },
            $push: {
              timeline: {
                $each: [
                  entry('placed', 'Order placed', 'We received your order.', now),
                  entry('funded', 'Payment secured in escrow', 'Your payment is held safely until the item is delivered.', now),
                ],
              },
            },
          },
          { returnDocument: 'after' },
        )
        .lean<Lean<Order>>();
      if (!order) continue; // Already funded (webhook and verify both arrived).
      await this.wallet.onFunded(order);
      for (const item of order.items) await this.products.recordSale(item.productId, item.quantity, item.price * item.quantity, now);
      await this.userService.incrementStats(order.buyerId, { purchases: 1 });
      await this.userService.incrementStats(order.sellerId, { sales: 1 });
      funded.push(order);
      this.announce(order, 'paid', 'system');
    }
    return funded;
  }

  /** The charge failed or lapsed: release the stock it was holding and close the orders. */
  async abandon(orderIds: Types.ObjectId[], reason: string): Promise<void> {
    for (const orderId of orderIds) {
      const order = await this.orders
        .findOneAndUpdate(
          { _id: orderId, status: 'awaiting-payment' },
          {
            $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'system', cancellationReason: reason, 'payment.status': 'failed' },
            $unset: { expiresAt: 1 },
          },
          { returnDocument: 'after' },
        )
        .lean<Lean<Order>>();
      if (!order) continue;
      for (const item of order.items) await this.products.releaseStock(item.productId, item.quantity);
    }
  }

  /** The provider finished (or failed) a refund for an order. */
  async applyRefundOutcome(orderId: Types.ObjectId, refund: { status: 'pending' | 'processed' | 'failed'; processedAt?: Date; failureReason?: string }): Promise<void> {
    const order = await this.orders
      .findOneAndUpdate(
        { _id: orderId, 'refund.status': 'pending' },
        { $set: { 'refund.status': refund.status, 'refund.processedAt': refund.processedAt ?? new Date(), 'refund.failureReason': refund.failureReason } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Order>>();
    if (!order) return;
    if (refund.status === 'processed') {
      await this.orders.updateOne({ _id: orderId }, { $push: { timeline: entry('refunded', 'Refund completed', 'Your money is back on your original payment method.') } });
    }
    this.announce(order, refund.status === 'processed' ? 'refund-processed' : 'refund-failed', 'system');
  }

  /* --- Money moves ------------------------------------------------------------------ */

  /**
   * Instructs the provider to return the buyer's payment for this order and
   * records the request. A provider failure leaves the refund marked
   * failed for the console to retry; the order is cancelled either way.
   */
  private async requestRefund(order: Lean<Order>, reason: string): Promise<void> {
    const refund = await this.payments.refundOrder({ orderId: order._id, amount: order.total, reason });
    await this.orders.updateOne(
      { _id: order._id },
      {
        $set: {
          refund: {
            status: refund.status,
            amount: refund.amount,
            refundReference: refund.refundReference,
            requestedAt: refund.requestedAt,
            processedAt: refund.processedAt,
            failureReason: refund.failureReason,
          },
        },
      },
    );
  }

  /** Releases held funds to the seller. */
  async releaseEscrow(
    order: Lean<Order>,
    by: Actor,
    settlement: Extract<Settlement, 'released' | 'force-released'> = 'released',
    note?: string,
    options: { fromDispute?: boolean } = {},
  ): Promise<Lean<Order>> {
    const now = new Date();
    const fromPhases: EscrowPhase[] =
      settlement === 'force-released' || options.fromDispute ? ['disputed'] : phasesLeadingTo('released').filter((phase) => phase !== 'disputed');
    const deliveredNow = order.status !== 'delivered';
    const released = await this.transition(
      { _id: order._id, 'escrow.phase': { $in: fromPhases }, status: { $in: ['pending', 'confirmed', 'shipped', 'delivered'] } },
      {
        $set: {
          status: 'delivered',
          completedAt: now,
          ...(deliveredNow ? { deliveredAt: order.deliveredAt ?? now } : {}),
          'escrow.phase': 'released',
          'escrow.status': 'completed',
          'escrow.settlement': settlement,
          'escrow.releasedAt': now,
          'escrow.settledBy': by.id ? `${by.kind}:${by.id}` : by.kind,
          'escrow.settledAt': now,
          ...(order.escrow?.receivedAt ? {} : { 'escrow.receivedAt': now }),
        },
        $push: {
          'escrow.history': this.historyEntry(settlement, by, note),
          timeline: entry('released', 'Order completed', by.kind === 'buyer' ? 'You confirmed the item and payment was released to the seller.' : 'Payment was released to the seller.', now),
        },
      },
      'released',
    );
    await this.wallet.onReleased(released);
    this.announce(released, 'released', by.kind, note);
    return released;
  }

  /** Cancels a paid order and refunds the buyer in full. */
  async refundEscrow(order: Lean<Order>, by: Actor, reason: string, allowFrom: EscrowPhase[] = ['funded', 'shipped', 'inspection']): Promise<Lean<Order>> {
    const now = new Date();
    const cancelled = await this.transition(
      { _id: order._id, 'escrow.phase': { $in: allowFrom } },
      {
        $set: {
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: by.kind,
          cancellationReason: reason,
          'escrow.phase': 'refunded',
          'escrow.status': 'completed',
          'escrow.settlement': 'refunded',
          'escrow.refundedAt': now,
          'escrow.settledBy': by.id ? `${by.kind}:${by.id}` : by.kind,
          'escrow.settledAt': now,
        },
        $unset: { cancellationRequest: 1 },
        $push: {
          'escrow.history': this.historyEntry('refunded', by, reason),
          timeline: entry('cancelled', 'Order cancelled', `${reason} A full refund has been requested to your original payment method.`, now),
        },
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
    const latest = (await this.findById(cancelled._id))!;
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
      { _id: order._id, status: 'confirmed', cancellationRequest: null },
      {
        $set: { cancellationRequest: { reason, requestedAt: new Date() } },
        $push: { timeline: entry('cancellation-requested', 'Cancellation requested', reason) },
      },
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

  private async startInspection(order: Lean<Order>, by: Actor, proofUrl?: string, note?: string): Promise<Lean<Order>> {
    const settings = await this.settings.get();
    const now = new Date();
    const fromStatuses: OrderStatus[] = by.kind === 'seller' ? ['confirmed', 'shipped'] : ['shipped'];
    const updated = await this.transition(
      { _id: order._id, status: { $in: fromStatuses }, 'escrow.phase': { $in: ['funded', 'shipped'] } },
      {
        $set: {
          status: 'delivered',
          deliveredAt: now,
          returnBy: addDays(now, settings.disputes.returnWindowDays),
          'escrow.phase': 'inspection',
          'escrow.receivedAt': now,
          'escrow.inspectionEndsAt': addDays(now, settings.escrow.autoReleaseDays),
          ...(proofUrl ? { 'shipment.proofUrl': proofUrl } : {}),
        },
        $push: {
          'escrow.history': this.historyEntry('received', by, note),
          timeline: entry(
            'delivered',
            'Delivered',
            by.kind === 'buyer' ? 'You marked the item as received. The inspection period has started.' : 'The seller marked the order as delivered. The inspection period has started.',
            now,
          ),
        },
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
    return this.otp.issue({ key: `user:${user.id}`, purpose: 'confirm-release', channel, to, userId: user.id, context: String(order._id) });
  }

  /** The buyer confirms the item is as described: payment goes to the seller. */
  async release(user: AuthUser, idOrReference: string, code: string): Promise<BuyerOrderView> {
    const order = await this.forBuyer(user, idOrReference);
    if (!order.escrow || !['shipped', 'inspection'].includes(order.escrow.phase)) {
      throw Errors.conflict('There is nothing to release on this order right now.', 'ORDER_STATE_CHANGED', { status: order.status });
    }
    await this.otp.verify({ key: `user:${user.id}`, purpose: 'confirm-release', code, context: String(order._id) });
    const released = await this.releaseEscrow(order, { kind: 'buyer', id: user.id, name: user.firstName });
    return (await this.buyerViews([released]))[0];
  }

  /* --- Seller actions ------------------------------------------------------------- */

  async confirm(user: AuthUser, idOrReference: string): Promise<SellerOrderView> {
    const order = await this.forSeller(user, idOrReference);
    const updated = await this.transition(
      { _id: order._id, status: 'pending' },
      {
        $set: { status: 'confirmed', confirmedAt: new Date() },
        $push: { timeline: entry('confirmed', 'Order confirmed', 'The seller confirmed your order and is preparing it for dispatch.') },
      },
      'confirmed',
    );
    this.announce(updated, 'confirmed', 'seller');
    return (await this.sellerViews([updated]))[0];
  }

  async ship(user: AuthUser, idOrReference: string, input: { carrier: string; trackingNumber: string; proofUrl?: string; note?: string }): Promise<SellerOrderView> {
    const order = await this.forSeller(user, idOrReference);
    const now = new Date();
    const updated = await this.transition(
      { _id: order._id, status: { $in: ['pending', 'confirmed'] }, 'escrow.phase': 'funded' },
      {
        $set: {
          status: 'shipped',
          confirmedAt: order.confirmedAt ?? now,
          shipment: { carrier: input.carrier, trackingNumber: input.trackingNumber, proofUrl: input.proofUrl, note: input.note, shippedAt: now },
          'escrow.phase': 'shipped',
          'escrow.shippedAt': now,
        },
        $unset: { cancellationRequest: 1 },
        $push: {
          'escrow.history': this.historyEntry('shipped', { kind: 'seller', id: user.id, name: user.firstName }),
          timeline: entry('shipped', 'Shipped', `Package handed to ${input.carrier}. Tracking number ${input.trackingNumber}.`, now),
        },
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
  async markDisputed(orderId: Types.ObjectId, disputeId: Types.ObjectId, by: Actor, reason: string): Promise<Lean<Order>> {
    const order = await this.findById(orderId);
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    const updated = await this.transition(
      { _id: orderId, 'escrow.phase': { $in: ['shipped', 'inspection'] }, disputeId: null },
      {
        $set: {
          disputeId,
          'escrow.phaseBeforeDispute': order.escrow?.phase,
          'escrow.phase': 'disputed',
          'escrow.status': 'dispute',
          'escrow.disputedAt': new Date(),
        },
        $push: {
          'escrow.history': this.historyEntry('disputed', by, reason),
          timeline: entry('disputed', 'Dispute opened', 'Payment is on hold while DOOAA reviews the dispute.'),
        },
      },
      'disputed',
    );
    this.announce(updated, 'disputed', by.kind, reason);
    return updated;
  }

  /** DOOAA reopened a dispute it had closed without action: the payment goes back on hold under it. */
  async reopenDispute(orderId: Types.ObjectId, disputeId: Types.ObjectId, by: Actor, reason: string): Promise<Lean<Order>> {
    const order = await this.findById(orderId);
    if (!order?.escrow) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    const updated = await this.transition(
      { _id: orderId, disputeId, 'escrow.phase': { $in: ['shipped', 'inspection'] } },
      {
        $set: {
          'escrow.phaseBeforeDispute': order.escrow.phase,
          'escrow.phase': 'disputed',
          'escrow.status': 'dispute',
          'escrow.disputedAt': new Date(),
        },
        $push: {
          'escrow.history': this.historyEntry('disputed', by, reason),
          timeline: entry('disputed', 'Dispute reopened', 'Payment is on hold again while DOOAA takes another look.'),
        },
      },
      'disputed',
    );
    this.announce(updated, 'disputed', by.kind, reason);
    return updated;
  }

  /** A dispute closed without a ruling: the money goes back to where it was. */
  async restoreFromDispute(orderId: Types.ObjectId, by: Actor, note?: string): Promise<Lean<Order>> {
    const order = await this.findById(orderId);
    if (!order?.escrow || order.escrow.phase !== 'disputed') {
      throw Errors.conflict('This order is not under dispute.', 'ORDER_STATE_CHANGED');
    }
    const back = order.escrow.phaseBeforeDispute ?? 'inspection';
    const settings = await this.settings.get();
    const updated = await this.transition(
      { _id: orderId, 'escrow.phase': 'disputed' },
      {
        $set: {
          'escrow.phase': back,
          'escrow.status': 'pending',
          'escrow.phaseBeforeDispute': null,
          // A fresh inspection window, so the auto-release does not fire the moment the dispute closes.
          ...(back === 'inspection' ? { 'escrow.inspectionEndsAt': addDays(new Date(), settings.escrow.autoReleaseDays) } : {}),
        },
        $push: { 'escrow.history': this.historyEntry('dispute-closed', by, note), timeline: entry('dispute-closed', 'Dispute closed', note ?? 'The dispute was closed and the order continues.') },
      },
      'restored',
    );
    this.announce(updated, 'dispute-closed', by.kind, note);
    return updated;
  }

  /** Reverses a release: the funds go back on hold under a dispute. */
  async reverseRelease(order: Lean<Order>, by: Actor, note?: string): Promise<Lean<Order>> {
    if (order.escrow?.settlement === 'refunded') {
      throw Errors.conflict('The refund has already been paid back to the buyer and cannot be reversed from the console.', 'REFUND_IRREVERSIBLE');
    }
    // Take the money back off the seller's balance first; refuse if it has been withdrawn.
    await this.wallet.onReversed(order);
    const updated = await this.transition(
      { _id: order._id, 'escrow.phase': 'released' },
      {
        $set: {
          'escrow.phase': 'disputed',
          'escrow.status': 'dispute',
          'escrow.settlement': 'reversed',
          'escrow.phaseBeforeDispute': 'inspection',
          'escrow.disputedAt': new Date(),
          'escrow.settledBy': by.id ? `${by.kind}:${by.id}` : by.kind,
          'escrow.settledAt': new Date(),
        },
        $unset: { completedAt: 1 },
        $push: { 'escrow.history': this.historyEntry('reversed', by, note), timeline: entry('reversed', 'Release reversed', 'DOOAA put the payment back on hold for review.') },
      },
      'reversed',
    );
    this.announce(updated, 'reversed', by.kind, note);
    return updated;
  }

  /* --- Background work ---------------------------------------------------------- */

  /** Inspection windows that have run out release to the seller. */
  async autoRelease(now = new Date()): Promise<number> {
    const due = await this.orders.find({ 'escrow.phase': 'inspection', 'escrow.inspectionEndsAt': { $lte: now } }).limit(200).lean<Lean<Order>[]>();
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
    const due = await this.orders.find({ status: { $in: ['pending', 'confirmed'] }, 'escrow.phase': 'funded', shipBy: { $lte: cutoff } }).limit(200).lean<Lean<Order>[]>();
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
    const id = new Types.ObjectId(userId);
    const open = await this.orders.countDocuments({
      $or: [{ buyerId: id }, { sellerId: id }],
      $and: [{ $or: [{ status: { $in: ACTIVE_FOR_CLOSURE } }, { 'escrow.phase': { $in: [...HELD_PHASES, 'disputed'] } }] }],
    });
    if (open > 0) {
      throw Errors.conflict('You have orders in progress. Close your account once they are completed.', 'OPEN_ORDERS', { open });
    }
    if (await this.wallet.hasOpenBalance(userId)) {
      throw Errors.conflict('You still have earnings on DOOAA. Withdraw your balance before closing your account.', 'OPEN_BALANCE');
    }
  }

  /* --- Dashboards -------------------------------------------------------------- */

  /** The seller dashboard's headline tiles, with week-on-week change. */
  async sellerSummary(user: AuthUser) {
    const sellerId = new Types.ObjectId(user.id);
    const now = Date.now();
    const thisWeek = new Date(now - 7 * DAY);
    const lastWeek = new Date(now - 14 * DAY);
    const [revenueRows, totalOrders, pendingOrders, activeProducts, ordersThis, ordersLast, revenueThis, revenueLast, listedThis, listedLast, pendingThis, pendingLast] =
      await Promise.all([
        this.orders.aggregate<{ total: number }>([{ $match: { sellerId, 'escrow.phase': 'released' } }, { $group: { _id: null, total: { $sum: '$sellerEarning' } } }]),
        this.orders.countDocuments({ sellerId, status: { $ne: 'awaiting-payment' }, 'payment.status': 'paid' }),
        this.orders.countDocuments({ sellerId, status: { $in: ['pending', 'confirmed'] } }),
        this.products.model.countDocuments({ sellerId, status: 'active', deletedAt: null }),
        this.orders.countDocuments({ sellerId, 'payment.status': 'paid', 'payment.paidAt': { $gte: thisWeek } }),
        this.orders.countDocuments({ sellerId, 'payment.status': 'paid', 'payment.paidAt': { $gte: lastWeek, $lt: thisWeek } }),
        this.sumReleased(sellerId, thisWeek, new Date(now)),
        this.sumReleased(sellerId, lastWeek, thisWeek),
        this.products.model.countDocuments({ sellerId, publishedAt: { $gte: thisWeek }, deletedAt: null }),
        this.products.model.countDocuments({ sellerId, publishedAt: { $gte: lastWeek, $lt: thisWeek }, deletedAt: null }),
        this.orders.countDocuments({ sellerId, status: { $in: ['pending', 'confirmed'] }, createdAt: { $gte: thisWeek } }),
        this.orders.countDocuments({ sellerId, status: { $in: ['pending', 'confirmed'] }, createdAt: { $gte: lastWeek, $lt: thisWeek } }),
      ]);
    const change = (current: number, previous: number) => (previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 1000) / 10);
    return {
      revenue: Math.round((revenueRows[0]?.total ?? 0) * 100) / 100,
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

  private async sumReleased(sellerId: Types.ObjectId, from: Date, to: Date): Promise<number> {
    const rows = await this.orders.aggregate<{ total: number }>([
      { $match: { sellerId, 'escrow.phase': 'released', 'escrow.releasedAt': { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: '$sellerEarning' } } },
    ]);
    return rows[0]?.total ?? 0;
  }
}
