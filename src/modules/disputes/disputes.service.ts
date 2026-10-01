import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import { OUTCOME_LABEL, OUTCOME_STATE, type DisputeOutcome, type DisputeState } from '../../common/domain';
import { addHours, clockTime, dayKey } from '../../common/util/dates';
import { formatNaira } from '../../common/util/money';
import type { Lean } from '../../common/util/mongo';
import { containsRegex, shortName } from '../../common/util/text';
import { CountersService } from '../../database/counters.service';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { AuditService } from '../audit/audit.service';
import { ConversationsService } from '../conversations/conversations.service';
import type { Message } from '../conversations/schemas/message.schema';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ORDER_EVENTS, OrdersService, type OrderUpdated } from '../orders/orders.service';
import { Order } from '../orders/schemas/order.schema';
import { RealtimeService } from '../realtime/realtime.service';
import { SERVER_EVENTS } from '../realtime/realtime.events';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/schemas/user.schema';
import { Dispute } from './dispute.schema';

export type ThreadEntry = {
  id: string;
  kind: 'message' | 'attachment' | 'event';
  party: 'buyer' | 'seller' | 'admin';
  /** Lagos calendar day; the "Yesterday"/"Today" chips are grouped from it. */
  day: string;
  /** "04:15pm". */
  time: string;
  at: string;
  body?: string;
  image?: string;
};

export type AdminDisputeView = {
  id: string;
  reference: string;
  item: string;
  state: DisputeState;
  outcome: DisputeOutcome | null;
  openedOn: string;
  openedAt: string;
  openedBy: 'buyer' | 'seller';
  buyerId: string;
  buyerName: string;
  buyerShortName: string;
  buyerAvatar: string | null;
  sellerId: string;
  sellerName: string;
  sellerAvatar: string | null;
  orderId: string;
  orderValue: number;
  orderNumber: string;
  purchaseDate: string;
  buyerClaim: string;
  sellerClaim: string;
  evidence: string | null;
  evidenceAll: string[];
  responseDueAt: string;
  resolutionNote: string | null;
  conversationId: string | null;
  thread: ThreadEntry[];
};

export type PartyDisputeView = {
  id: string;
  reference: string;
  state: DisputeState;
  outcome: DisputeOutcome | null;
  outcomeLabel: string | null;
  orderNumber: string;
  item: string;
  reason: string;
  sellerClaim: string | null;
  evidence: string[];
  sellerEvidence: string[];
  openedAt: string;
  responseDueAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  conversationId: string | null;
};

@Injectable()
export class DisputesService implements OnModuleInit {
  constructor(
    @InjectModel(Dispute.name) private readonly disputes: Model<Dispute>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly orderService: OrdersService,
    private readonly conversations: ConversationsService,
    private readonly counters: CountersService,
    private readonly media: MediaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // A ruling made from the escrow ledger (force-release, refund) closes the dispute too.
    this.events.on<OrderUpdated>(ORDER_EVENTS.updated, async ({ order, event }) => {
      if (!order.disputeId || (event !== 'released' && event !== 'cancelled')) return;
      await this.disputes.updateOne(
        { _id: order.disputeId, state: { $ne: 'completed' } },
        { $set: { state: 'completed', outcome: event === 'released' ? 'released' : 'refunded', resolvedAt: new Date() } },
      );
    });
  }

  private partyView(row: Lean<Dispute>): PartyDisputeView {
    return {
      id: String(row._id),
      reference: row.reference,
      state: row.state,
      outcome: row.outcome,
      outcomeLabel: row.outcome ? OUTCOME_LABEL[row.outcome] : null,
      orderNumber: row.orderNumber,
      item: row.item,
      reason: row.reason,
      sellerClaim: row.sellerClaim ?? null,
      evidence: row.evidence,
      sellerEvidence: row.sellerEvidence,
      openedAt: new Date(row.createdAt).toISOString(),
      responseDueAt: new Date(row.responseDueAt).toISOString(),
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
      resolutionNote: row.resolutionNote ?? null,
      conversationId: row.conversationId ? String(row.conversationId) : null,
    };
  }

  /* --- Parties ------------------------------------------------------------------ */

  /** "Report a problem" on an order: payment freezes until DOOAA rules. */
  async open(user: AuthUser, orderIdOrReference: string, input: { reason: string; evidence?: string[] }): Promise<PartyDisputeView> {
    const reference = orderIdOrReference.replace(/^#/, '');
    const filter = /^[a-f\d]{24}$/i.test(reference) ? { _id: new Types.ObjectId(reference) } : { reference };
    const order = await this.orders.findOne({ ...filter, buyerId: new Types.ObjectId(user.id) }).lean<Lean<Order>>();
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    if (order.disputeId) throw Errors.conflict('There is already a dispute on this order.', 'DISPUTE_EXISTS');
    if (!order.escrow || !['shipped', 'inspection'].includes(order.escrow.phase)) {
      throw Errors.conflict(
        order.status === 'pending' || order.status === 'confirmed' ? 'This order has not shipped yet — cancel it instead.' : 'This order can no longer be disputed.',
        'ORDER_NOT_DISPUTABLE',
        { status: order.status },
      );
    }
    const evidence = input.evidence ?? [];
    if (evidence.length) await this.media.assertOwnedUrls(evidence, { id: user.id, type: 'user' }, ['evidence', 'message']);

    const settings = await this.settings.section('disputes');
    const number = await this.counters.next('dispute', 3600);
    const dispute = await this.disputes.create({
      reference: `#${number}`,
      orderId: order._id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      item: order.items.length > 1 ? `${order.items[0].title} +${order.items.length - 1} more` : order.items[0].title,
      orderValue: order.total,
      orderNumber: `#${order.reference}`,
      purchaseDate: order.payment.paidAt ?? order.createdAt,
      state: 'active',
      openedBy: 'buyer',
      reason: input.reason,
      evidence,
      responseDueAt: addHours(new Date(), settings.responseHours),
    });

    await this.orderService.markDisputed(order._id, dispute._id, { kind: 'buyer', id: user.id, name: user.firstName }, input.reason);
    const conversation = await this.conversations.ensureForOrder((await this.orders.findById(order._id).lean<Lean<Order>>())!);
    await this.disputes.updateOne({ _id: dispute._id }, { $set: { conversationId: conversation._id } });
    await this.conversations.linkDispute(conversation._id, dispute._id);
    await this.conversations.postDispute(conversation._id, user, input.reason, evidence[0]);

    void this.notifications.notifyUser(order.sellerId, {
      type: 'dispute.opened',
      title: `Dispute ${dispute.reference} on order #${order.reference}`,
      body: `The buyer says: ${input.reason.slice(0, 140)} Respond within ${settings.responseHours} hours.`,
      tone: 'red',
      link: `/messages?c=${String(conversation._id)}`,
      email: {
        subject: `A buyer opened a dispute on order #${order.reference}`,
        heading: 'A dispute needs your response',
        paragraphs: [
          `The buyer of ${order.items[0].title} says: “${input.reason}”`,
          `Payment is on hold. Reply with your side and any evidence within ${settings.responseHours} hours.`,
        ],
        cta: { label: 'Respond', url: `${this.config.clientUrl}/messages?c=${String(conversation._id)}` },
      },
    });
    const alerts = await this.settings.section('notifications');
    if (alerts.newDispute) {
      await this.notifications.notifyStaff({
        type: 'dispute.opened',
        title: `New dispute ${dispute.reference}`,
        body: `${dispute.item} — ${formatNaira(order.total)}.`,
        tone: 'red',
        link: `/disputes?id=${String(dispute._id)}`,
      });
    }
    this.realtime.toAllStaff(SERVER_EVENTS.disputeUpdated, { id: String(dispute._id), state: 'active' });
    return this.partyView((await this.disputes.findById(dispute._id).lean<Lean<Dispute>>())!);
  }

  private async forParty(user: AuthUser, id: string): Promise<{ dispute: Lean<Dispute>; role: 'buyer' | 'seller' }> {
    const dispute = Types.ObjectId.isValid(id) ? await this.disputes.findById(id).lean<Lean<Dispute>>() : null;
    if (!dispute) throw Errors.notFound('That dispute does not exist.', 'DISPUTE_NOT_FOUND');
    if (String(dispute.buyerId) === user.id) return { dispute, role: 'buyer' };
    if (String(dispute.sellerId) === user.id) return { dispute, role: 'seller' };
    throw Errors.notFound('That dispute does not exist.', 'DISPUTE_NOT_FOUND');
  }

  async get(user: AuthUser, id: string): Promise<PartyDisputeView> {
    return this.partyView((await this.forParty(user, id)).dispute);
  }

  async mine(user: AuthUser): Promise<PartyDisputeView[]> {
    const me = new Types.ObjectId(user.id);
    const rows = await this.disputes.find({ $or: [{ buyerId: me }, { sellerId: me }] }).sort({ createdAt: -1 }).limit(100).lean<Lean<Dispute>[]>();
    return rows.map((row) => this.partyView(row));
  }

  /** The seller's side of the story. */
  async respond(user: AuthUser, id: string, input: { claim: string; evidence?: string[] }): Promise<PartyDisputeView> {
    const { dispute, role } = await this.forParty(user, id);
    if (role !== 'seller') throw Errors.forbidden('Only the seller responds to a dispute.', 'NOT_SELLER');
    if (dispute.state === 'completed') throw Errors.conflict('This dispute has been settled.', 'DISPUTE_CLOSED');
    const evidence = input.evidence ?? [];
    if (evidence.length) await this.media.assertOwnedUrls(evidence, { id: user.id, type: 'user' }, ['evidence', 'message']);
    const updated = await this.disputes
      .findByIdAndUpdate(dispute._id, { $set: { sellerClaim: input.claim, state: 'active' }, $push: { sellerEvidence: { $each: evidence } } }, { returnDocument: 'after' })
      .lean<Lean<Dispute>>();
    if (dispute.conversationId) {
      await this.conversations.send(user, String(dispute.conversationId), { kind: 'text', body: input.claim });
      for (const url of evidence) await this.conversations.send(user, String(dispute.conversationId), { kind: 'image', mediaUrl: url });
    }
    this.realtime.toAllStaff(SERVER_EVENTS.disputeUpdated, { id, state: 'active' });
    return this.partyView(updated!);
  }

  /* --- Console --------------------------------------------------------------------- */

  private async adminViews(rows: Lean<Dispute>[], withThread = false): Promise<AdminDisputeView[]> {
    const people = await this.users.find({ _id: { $in: rows.flatMap((row) => [row.buyerId, row.sellerId]) } }).lean<Lean<User>[]>();
    const byId = new Map(people.map((person) => [String(person._id), person]));
    const views: AdminDisputeView[] = [];
    for (const row of rows) {
      const buyer = byId.get(String(row.buyerId));
      const seller = byId.get(String(row.sellerId));
      const buyerName = buyer ? `${buyer.firstName} ${buyer.lastName}` : 'Buyer';
      views.push({
        id: String(row._id),
        reference: row.reference,
        item: row.item,
        state: row.state,
        outcome: row.outcome,
        openedOn: dayKey(row.createdAt),
        openedAt: new Date(row.createdAt).toISOString(),
        openedBy: row.openedBy,
        buyerId: String(row.buyerId),
        buyerName,
        buyerShortName: shortName(buyerName),
        buyerAvatar: buyer?.avatarUrl ?? null,
        sellerId: String(row.sellerId),
        sellerName: seller ? (seller.seller?.storeName || `${seller.firstName} ${seller.lastName}`) : 'Seller',
        sellerAvatar: seller?.avatarUrl ?? null,
        orderId: String(row.orderId),
        orderValue: row.orderValue,
        orderNumber: row.orderNumber,
        purchaseDate: dayKey(row.purchaseDate),
        buyerClaim: row.reason,
        sellerClaim: row.sellerClaim ?? '',
        evidence: row.evidence[0] ?? null,
        evidenceAll: [...row.evidence, ...row.sellerEvidence],
        responseDueAt: new Date(row.responseDueAt).toISOString(),
        resolutionNote: row.resolutionNote ?? null,
        conversationId: row.conversationId ? String(row.conversationId) : null,
        thread: withThread && row.conversationId ? this.thread(await this.conversations.threadFor(row.conversationId), row) : [],
      });
    }
    return views;
  }

  /** The conversation as the moderation pane draws it. */
  private thread(messages: Lean<Message>[], dispute: Lean<Dispute>): ThreadEntry[] {
    const entries: ThreadEntry[] = [];
    for (const message of messages) {
      const party: ThreadEntry['party'] = message.senderRole === 'buyer' ? 'buyer' : message.senderRole === 'seller' ? 'seller' : 'admin';
      const base = { party, day: dayKey(message.createdAt), time: clockTime(message.createdAt), at: new Date(message.createdAt).toISOString() };
      const id = String(message._id);
      switch (message.kind) {
        case 'image':
        case 'video':
        case 'file':
          entries.push({ id: `${id}_a`, kind: 'attachment', ...base, image: message.media?.posterUrl ?? message.media?.url });
          if (message.body) entries.push({ id, kind: 'message', ...base, body: message.body });
          break;
        case 'dispute':
          entries.push({ id, kind: 'event', ...base, body: `Dispute opened by ${message.dispute?.by ?? (dispute.openedBy === 'buyer' ? 'Buyer' : 'Seller')}` });
          break;
        case 'system':
          entries.push({ id, kind: 'event', ...base, party: 'admin', body: [message.systemLead, message.body].filter(Boolean).join(' ') });
          break;
        case 'meetup':
          entries.push({ id, kind: 'message', ...base, body: `Proposed a meetup at ${message.meetup?.venue ?? 'a public place'} on ${message.meetup?.date ?? ''} (${message.meetup?.from ?? ''}–${message.meetup?.to ?? ''}).` });
          break;
        default:
          entries.push({ id, kind: 'message', ...base, body: message.body });
      }
    }
    return entries;
  }

  async adminList(query: { search?: string; states?: DisputeState[]; outcomes?: DisputeOutcome[]; openedFrom?: string; openedTo?: string }): Promise<AdminDisputeView[]> {
    const filter: Record<string, unknown> = {};
    if (query.states?.length) filter.state = { $in: query.states };
    if (query.outcomes?.length) filter.outcome = { $in: query.outcomes };
    const opened: Record<string, Date> = {};
    if (query.openedFrom) opened.$gte = new Date(`${query.openedFrom}T00:00:00+01:00`);
    if (query.openedTo) opened.$lte = new Date(`${query.openedTo}T23:59:59.999+01:00`);
    if (Object.keys(opened).length) filter.createdAt = opened;
    if (query.search?.trim()) {
      const pattern = containsRegex(query.search);
      const people = await this.users.find({ $or: [{ firstName: pattern }, { lastName: pattern }, { 'seller.storeName': pattern }] }).select('_id').limit(200).lean();
      const ids = people.map((person) => person._id);
      filter.$or = [{ reference: pattern }, { item: pattern }, { orderNumber: pattern }, { buyerId: { $in: ids } }, { sellerId: { $in: ids } }];
    }
    const rows = await this.disputes.find(filter).sort({ createdAt: -1 }).limit(56).lean<Lean<Dispute>[]>();
    return this.adminViews(rows);
  }

  async adminGet(id: string): Promise<AdminDisputeView> {
    const row = Types.ObjectId.isValid(id) ? await this.disputes.findById(id).lean<Lean<Dispute>>() : null;
    if (!row) throw Errors.notFound('That dispute is no longer open to moderation.', 'DISPUTE_NOT_FOUND');
    return (await this.adminViews([row], true))[0];
  }

  /** The console composer: DOOAA support speaks in the thread both parties see. */
  async postMessage(staff: AuthStaff, id: string, body: string, image?: string): Promise<ThreadEntry> {
    const row = Types.ObjectId.isValid(id) ? await this.disputes.findById(id).lean<Lean<Dispute>>() : null;
    if (!row?.conversationId) throw Errors.notFound('That dispute is no longer open to moderation.', 'DISPUTE_NOT_FOUND');
    if (image) await this.media.assertOwnedUrls([image], { id: staff.id, type: 'staff' }, ['evidence', 'message']);
    const message = await this.conversations.postAdmin(row.conversationId, staff, body, image);
    return { id: String(message._id), kind: 'message', party: 'admin', day: dayKey(message.createdAt), time: clockTime(message.createdAt), at: new Date(message.createdAt).toISOString(), body, ...(image ? { image } : {}) };
  }

  /**
   * One of the four Moderation Actions. The money moves through the same
   * escrow paths as everywhere else, the thread is told, and the ruling is
   * audited.
   */
  async resolve(staff: AuthStaff, id: string, outcome: DisputeOutcome, note?: string): Promise<{ id: string; outcome: DisputeOutcome; state: DisputeState; dispute: AdminDisputeView }> {
    const row = Types.ObjectId.isValid(id) ? await this.disputes.findById(id).lean<Lean<Dispute>>() : null;
    if (!row) throw Errors.notFound('That dispute is no longer open to moderation.', 'DISPUTE_NOT_FOUND');
    if (row.state === 'completed') throw Errors.conflict('This dispute has already been settled.', 'DISPUTE_CLOSED');
    const order = await this.orders.findById(row.orderId).lean<Lean<Order>>();
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    const settings = await this.settings.section('disputes');
    const actor = { kind: 'staff' as const, id: staff.id, name: `${staff.firstName} ${staff.lastName}` };
    const state = OUTCOME_STATE[outcome];

    // Claim the ruling first so two moderators cannot both settle it.
    const claimed = await this.disputes.findOneAndUpdate(
      { _id: row._id, state: { $ne: 'completed' } },
      { $set: { state, outcome, resolvedBy: staff.id, resolvedAt: new Date(), resolutionNote: note } },
      { returnDocument: 'after' },
    );
    if (!claimed) throw Errors.conflict('This dispute has already been settled.', 'DISPUTE_CLOSED');

    try {
      switch (outcome) {
        case 'refunded':
          await this.orderService.refundEscrow(order, actor, note?.trim() || `Refunded after dispute ${row.reference}.`, ['disputed']);
          break;
        case 'released':
          await this.orderService.releaseEscrow(order, actor, 'released', note, { fromDispute: true });
          break;
        case 'closed':
          await this.orderService.restoreFromDispute(order._id, actor, note);
          break;
        case 'evidence-requested':
          break;
      }
    } catch (error) {
      // The money did not move: reopen the dispute so it can be ruled on again.
      await this.disputes.updateOne({ _id: row._id }, { $set: { state: row.state, outcome: row.outcome }, $unset: { resolvedBy: 1, resolvedAt: 1, resolutionNote: 1 } });
      throw error;
    }

    if (row.conversationId) {
      const line: Record<DisputeOutcome, string> = {
        refunded: `DOOAA reviewed dispute ${row.reference} and refunded the buyer in full.${note ? ` ${note}` : ''}`,
        released: `DOOAA reviewed dispute ${row.reference} and released the payment to the seller.${note ? ` ${note}` : ''}`,
        'evidence-requested': `Please provide a response to the claim and any additional evidence you have within ${settings.responseHours} hours.${note ? ` ${note}` : ''}`,
        closed: `Dispute ${row.reference} is closed without action. If something new comes up, reopen it through support within ${settings.reopenDays} days.${note ? ` ${note}` : ''}`,
      };
      await this.conversations.postAdmin(row.conversationId, staff, line[outcome]);
    }
    for (const party of [row.buyerId, row.sellerId]) {
      void this.notifications.notifyUser(party, {
        type: `dispute.${outcome}`,
        title: outcome === 'evidence-requested' ? `More evidence needed for ${row.reference}` : `Dispute ${row.reference} settled`,
        body: OUTCOME_LABEL[outcome],
        tone: outcome === 'evidence-requested' ? 'blue' : 'green',
        link: row.conversationId ? `/messages?c=${String(row.conversationId)}` : undefined,
      });
    }
    await this.audit.record(staff, {
      action: `Ruled on a dispute — ${OUTCOME_LABEL[outcome].toLowerCase()}`,
      target: `Dispute ${row.reference}`,
      targetType: 'dispute',
      targetId: id,
      meta: { outcome, note },
    });
    this.realtime.toAllStaff(SERVER_EVENTS.disputeUpdated, { id, state, outcome });
    return { id, outcome, state, dispute: await this.adminGet(id) };
  }

  /**
   * "Reopen dispute". Only a dispute closed without action can come back —
   * once DOOAA has refunded or released, the money has moved and the remedy
   * is a reversal on the payment itself. The window is the "reopen" days in
   * Settings, counted from when it was closed.
   */
  async reopen(staff: AuthStaff, id: string, note?: string): Promise<{ id: string; state: DisputeState; dispute: AdminDisputeView }> {
    const row = Types.ObjectId.isValid(id) ? await this.disputes.findById(id).lean<Lean<Dispute>>() : null;
    if (!row) throw Errors.notFound('That dispute is no longer open to moderation.', 'DISPUTE_NOT_FOUND');
    if (row.state !== 'completed') throw Errors.conflict('This dispute is still open.', 'DISPUTE_OPEN');
    if (row.outcome !== 'closed') {
      throw Errors.conflict('Money has already moved on this dispute. Reverse the payment from Payment Management instead.', 'DISPUTE_SETTLED');
    }
    const settings = await this.settings.section('disputes');
    const closedAt = row.resolvedAt ? new Date(row.resolvedAt).getTime() : 0;
    if (closedAt && Date.now() - closedAt > settings.reopenDays * 86_400_000) {
      throw Errors.conflict(`A dispute can only be reopened within ${settings.reopenDays} days of being closed.`, 'REOPEN_WINDOW_PASSED');
    }

    const claimed = await this.disputes.findOneAndUpdate(
      { _id: row._id, state: 'completed', outcome: 'closed' },
      { $set: { state: 'active', outcome: null, responseDueAt: addHours(new Date(), settings.responseHours) }, $unset: { resolvedBy: 1, resolvedAt: 1, resolutionNote: 1 } },
      { returnDocument: 'after' },
    );
    if (!claimed) throw Errors.conflict('This dispute changed while you were looking at it. Refresh and try again.', 'DISPUTE_CHANGED');

    const actor = { kind: 'staff' as const, id: staff.id, name: `${staff.firstName} ${staff.lastName}` };
    try {
      await this.orderService.reopenDispute(row.orderId, row._id, actor, note?.trim() || `DOOAA reopened dispute ${row.reference}.`);
    } catch (error) {
      await this.disputes.updateOne(
        { _id: row._id },
        { $set: { state: row.state, outcome: row.outcome, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt, resolutionNote: row.resolutionNote, responseDueAt: row.responseDueAt } },
      );
      if ((error as { code?: string }).code === 'ORDER_STATE_CHANGED') {
        throw Errors.conflict('The order has moved on since the dispute closed, so it cannot be reopened.', 'ORDER_MOVED_ON');
      }
      throw error;
    }

    if (row.conversationId) {
      await this.conversations.postAdmin(
        row.conversationId,
        staff,
        `DOOAA reopened dispute ${row.reference}. The payment is on hold again while we take another look.${note ? ` ${note.trim()}` : ''}`,
      );
    }
    for (const party of [row.buyerId, row.sellerId]) {
      void this.notifications.notifyUser(party, {
        type: 'dispute.reopened',
        title: `Dispute ${row.reference} reopened`,
        body: 'DOOAA is taking another look. The payment is on hold until then.',
        tone: 'blue',
        link: row.conversationId ? `/messages?c=${String(row.conversationId)}` : undefined,
      });
    }
    await this.audit.record(staff, {
      action: 'Reopened a dispute',
      target: `Dispute ${row.reference}`,
      targetType: 'dispute',
      targetId: id,
      meta: { note },
    });
    this.realtime.toAllStaff(SERVER_EVENTS.disputeUpdated, { id, state: 'active' });
    return { id, state: 'active', dispute: await this.adminGet(id) };
  }

  /** For the console's user profiles. */
  async forUser(userId: string): Promise<Lean<Dispute>[]> {
    const id = new Types.ObjectId(userId);
    return this.disputes.find({ $or: [{ buyerId: id }, { sellerId: id }] }).sort({ createdAt: -1 }).limit(20).lean<Lean<Dispute>[]>();
  }
}
