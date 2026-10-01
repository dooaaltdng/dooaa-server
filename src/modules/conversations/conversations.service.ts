import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import type { MessageKind, UserMessageKind } from '../../common/domain';
import { formatNaira } from '../../common/util/money';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { containsRegex, excerpt } from '../../common/util/text';
import { MediaService } from '../media/media.service';
import { ORDER_EVENTS, type OrderUpdated } from '../orders/orders.service';
import { Order } from '../orders/schemas/order.schema';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { ProductsService } from '../products/products.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SERVER_EVENTS } from '../realtime/realtime.events';
import { User } from '../users/schemas/user.schema';
import {
  ESCROW_LABEL,
  toConversationEscrow,
  toMessageView,
  toOfferView,
  type ConversationDetail,
  type ConversationSummary,
  type MessageView,
} from './conversation.presenter';
import { Conversation } from './schemas/conversation.schema';
import { Message, type MessageMeetup } from './schemas/message.schema';
import { Offer } from './schemas/offer.schema';

export const CONVERSATION_EVENTS = {
  message: 'conversation.message',
  offer: 'conversation.offer',
} as const;

export type ConversationMessageEvent = { conversation: Lean<Conversation>; message: Lean<Message>; recipientIds: string[]; senderName: string };
export type ConversationOfferEvent = { conversation: Lean<Conversation>; offer: Lean<Offer>; action: 'made' | 'accepted' | 'declined' | 'countered' | 'withdrawn'; actorId: string; recipientId: string };

type Participant = { role: 'buyer' | 'seller'; conversation: Lean<Conversation> };

const SYSTEM_LINES: Partial<Record<OrderUpdated['event'], (order: Lean<Order>, note?: string) => { lead: string; body: string }>> = {
  paid: (order) => ({ lead: 'Escrow funded.', body: `${formatNaira(order.total)} is held safely until the item is delivered.` }),
  confirmed: () => ({ lead: 'Order confirmed.', body: 'The seller is preparing the item for dispatch.' }),
  shipped: (order) => ({ lead: 'Item marked as shipped.', body: `${order.shipment?.carrier ?? 'Carrier'} · Tracking ${order.shipment?.trackingNumber ?? ''}`.trim() }),
  received: () => ({ lead: 'Item marked as received.', body: 'Inspection period started' }),
  delivered: () => ({ lead: 'Item marked as delivered.', body: 'Inspection period started' }),
  released: () => ({ lead: 'Funds released to seller.', body: 'This order is now complete.' }),
  cancelled: (_order, note) => ({ lead: 'Order cancelled.', body: note ? `${note} The buyer will be refunded in full.` : 'The buyer will be refunded in full.' }),
  'cancellation-requested': (_order, note) => ({ lead: 'Cancellation requested.', body: note ?? 'The buyer asked to cancel this order.' }),
  'refund-processed': () => ({ lead: 'Refund completed.', body: 'The money is back on the original payment method.' }),
  'dispute-closed': (_order, note) => ({ lead: 'Dispute closed.', body: note ?? 'The order continues.' }),
  reversed: () => ({ lead: 'Release reversed.', body: 'DOOAA put the payment back on hold for review.' }),
};

@Injectable()
export class ConversationsService implements OnModuleInit {
  constructor(
    @InjectModel(Conversation.name) private readonly conversations: Model<Conversation>,
    @InjectModel(Message.name) private readonly messages: Model<Message>,
    @InjectModel(Offer.name) private readonly offers: Model<Offer>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly products: ProductsService,
    private readonly media: MediaService,
    private readonly methods: PaymentMethodsService,
    private readonly realtime: RealtimeService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<OrderUpdated>(ORDER_EVENTS.updated, (event) => this.onOrderUpdated(event));
  }

  get model(): Model<Conversation> {
    return this.conversations;
  }

  /* --- Access --------------------------------------------------------------------- */

  async participant(user: { id: string }, conversationId: string): Promise<Participant> {
    if (!Types.ObjectId.isValid(conversationId)) throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
    const conversation = await this.conversations.findById(conversationId).lean<Lean<Conversation>>();
    if (!conversation) throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
    if (String(conversation.buyerId) === user.id) return { role: 'buyer', conversation };
    if (String(conversation.sellerId) === user.id) return { role: 'seller', conversation };
    throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
  }

  async isParticipant(userId: string, conversationId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(conversationId)) return false;
    return Boolean(await this.conversations.exists({ _id: conversationId, $or: [{ buyerId: new Types.ObjectId(userId) }, { sellerId: new Types.ObjectId(userId) }] }));
  }

  /* --- Views ---------------------------------------------------------------------- */

  private async summaries(rows: Lean<Conversation>[], viewerId: string): Promise<ConversationSummary[]> {
    const counterpartIds = rows.map((row) => (String(row.buyerId) === viewerId ? row.sellerId : row.buyerId));
    const orderIds = rows.map((row) => row.orderId).filter((id): id is Types.ObjectId => Boolean(id));
    const [people, orders, offers] = await Promise.all([
      this.users.find({ _id: { $in: [...counterpartIds, ...rows.map((row) => row.buyerId)] } }).lean<Lean<User>[]>(),
      this.orders.find({ _id: { $in: orderIds } }).select('reference escrow.phase').lean<Lean<Order>[]>(),
      this.offers.find({ conversationId: { $in: rows.map((row) => row._id) }, status: { $in: ['pending', 'countered', 'accepted'] } }).sort({ createdAt: -1 }).lean<Lean<Offer>[]>(),
    ]);
    const personById = new Map(people.map((person) => [String(person._id), person]));
    const orderById = new Map(orders.map((order) => [String(order._id), order]));
    const offerByConversation = new Map<string, Lean<Offer>>();
    for (const offer of offers) if (!offerByConversation.has(String(offer.conversationId))) offerByConversation.set(String(offer.conversationId), offer);

    return rows.map((row) => {
      const viewerRole: 'buyer' | 'seller' = String(row.buyerId) === viewerId ? 'buyer' : 'seller';
      const counterpartId = viewerRole === 'buyer' ? row.sellerId : row.buyerId;
      const person = personById.get(String(counterpartId));
      const order = row.orderId ? orderById.get(String(row.orderId)) : undefined;
      const offer = offerByConversation.get(String(row._id));
      const name = person ? `${person.firstName} ${person.lastName}`.trim() : 'DOOAA member';
      const verified = person?.identity === 'verified';
      return {
        id: String(row._id),
        viewerRole,
        counterpart: {
          id: String(counterpartId),
          name,
          avatarUrl: person?.avatarUrl ?? null,
          storeName: person?.seller?.storeName ?? null,
          verified,
          online: this.realtime.isOnline(String(counterpartId)),
        },
        name,
        store: viewerRole === 'buyer' ? (person?.seller?.storeName ?? null) : 'Buyer',
        verified: viewerRole === 'buyer' ? verified : false,
        productId: row.productId ? String(row.productId) : null,
        subject: row.subject ? { title: row.subject.title, summary: row.subject.summary, image: row.subject.image, price: row.subject.price } : null,
        preview: row.lastMessage?.preview ?? '',
        lastMessageAt: new Date(row.lastMessage?.at ?? row.updatedAt).toISOString(),
        unread: viewerRole === 'buyer' ? row.buyerUnread : row.sellerUnread,
        escrow: order?.escrow ? { orderId: order.reference, phase: order.escrow.phase, status: ESCROW_LABEL[order.escrow.phase] } : null,
        offer: offer ? toOfferView(offer, personById.get(String(row.buyerId)) ?? null, row.subject) : null,
      };
    });
  }

  async list(user: AuthUser, query: { filter?: 'all' | 'unread'; q?: string; page?: number; limit?: number }): Promise<Page<ConversationSummary>> {
    const me = new Types.ObjectId(user.id);
    const filter: Record<string, unknown> = { $or: [{ buyerId: me }, { sellerId: me }] };
    if (query.filter === 'unread') {
      filter.$or = [
        { buyerId: me, buyerUnread: { $gt: 0 } },
        { sellerId: me, sellerUnread: { $gt: 0 } },
      ];
    }
    if (query.q?.trim()) {
      const pattern = containsRegex(query.q);
      const people = await this.users.find({ $or: [{ firstName: pattern }, { lastName: pattern }, { 'seller.storeName': pattern }] }).select('_id').limit(200).lean();
      const ids = people.map((person) => person._id);
      filter.$and = [{ $or: [{ 'subject.title': pattern }, { 'lastMessage.preview': pattern }, { buyerId: { $in: ids } }, { sellerId: { $in: ids } }] }];
    }
    const total = await this.conversations.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 30);
    const rows = await this.conversations.find(filter).sort({ 'lastMessage.at': -1, updatedAt: -1 }).skip(window.skip).limit(window.size).lean<Lean<Conversation>[]>();
    return toPage(await this.summaries(rows, user.id), total, window);
  }

  async detail(user: AuthUser, conversationId: string): Promise<ConversationDetail> {
    const { conversation } = await this.participant(user, conversationId);
    return this.buildDetail(conversation, user.id);
  }

  async buildDetail(conversation: Lean<Conversation>, viewerId: string): Promise<ConversationDetail> {
    const [summary] = await this.summaries([conversation], viewerId);
    const { messages, hasMore } = await this.page(conversation._id, viewerId, {});
    let escrow = null;
    if (conversation.orderId) {
      const order = await this.orders.findById(conversation.orderId).lean<Lean<Order>>();
      if (order) {
        const [buyer, seller, payout] = await Promise.all([
          this.users.findById(order.buyerId).lean<Lean<User>>(),
          this.users.findById(order.sellerId).lean<Lean<User>>(),
          this.methods.payoutAccount(String(order.sellerId)),
        ]);
        escrow = toConversationEscrow(order, buyer, seller, payout?.last4);
      }
    }
    return { ...summary, escrow, messages, hasMore };
  }

  private async page(conversationId: Types.ObjectId, viewerId: string, query: { before?: string; limit?: number }): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const limit = Math.min(query.limit ?? 50, 100);
    const filter: Record<string, unknown> = { conversationId };
    if (query.before && Types.ObjectId.isValid(query.before)) {
      const pivot = await this.messages.findById(query.before).select('createdAt').lean();
      if (pivot) filter.$or = [{ createdAt: { $lt: pivot.createdAt } }, { createdAt: pivot.createdAt, _id: { $lt: pivot._id } }];
    }
    const rows = await this.messages.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean<Lean<Message>[]>();
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map((row) => toMessageView(row, viewerId)), hasMore };
  }

  async messagesPage(user: AuthUser, conversationId: string, query: { before?: string; limit?: number }) {
    const { conversation } = await this.participant(user, conversationId);
    return this.page(conversation._id, user.id, query);
  }

  async unreadCount(userId: string): Promise<{ threads: number; messages: number }> {
    const me = new Types.ObjectId(userId);
    const [asBuyer, asSeller] = await Promise.all([
      this.conversations.aggregate<{ threads: number; messages: number }>([
        { $match: { buyerId: me, buyerUnread: { $gt: 0 } } },
        { $group: { _id: null, threads: { $sum: 1 }, messages: { $sum: '$buyerUnread' } } },
      ]),
      this.conversations.aggregate<{ threads: number; messages: number }>([
        { $match: { sellerId: me, sellerUnread: { $gt: 0 } } },
        { $group: { _id: null, threads: { $sum: 1 }, messages: { $sum: '$sellerUnread' } } },
      ]),
    ]);
    return {
      threads: (asBuyer[0]?.threads ?? 0) + (asSeller[0]?.threads ?? 0),
      messages: (asBuyer[0]?.messages ?? 0) + (asSeller[0]?.messages ?? 0),
    };
  }

  /* --- Starting threads ---------------------------------------------------------------- */

  /**
   * "Message seller" from a listing (or a seller's page). Reuses the open
   * thread about the same listing rather than starting another.
   */
  async start(user: AuthUser, input: { productId?: string; sellerId?: string; body?: string }): Promise<ConversationDetail> {
    let sellerId: Types.ObjectId;
    let productId: Types.ObjectId | undefined;
    let subject: Conversation['subject'] | undefined;
    let price = 0;
    if (input.productId) {
      const product = await this.products.findPublic(input.productId);
      sellerId = product.sellerId;
      productId = product._id;
      price = product.price;
      subject = { title: product.title, summary: product.summary || excerpt(product.description, 160), image: product.images[0] ?? '', price: product.price };
    } else if (input.sellerId && Types.ObjectId.isValid(input.sellerId)) {
      sellerId = new Types.ObjectId(input.sellerId);
      const seller = await this.users.findById(sellerId).select('role status').lean();
      if (!seller || seller.status === 'closed' || seller.status === 'banned') throw Errors.notFound('That seller is not on DOOAA.', 'SELLER_NOT_FOUND');
    } else {
      throw Errors.badRequest('Choose a listing or a seller to message.', 'VALIDATION_FAILED');
    }
    if (String(sellerId) === user.id) throw Errors.forbidden('You cannot message yourself.', 'OWN_LISTING');

    const buyerId = new Types.ObjectId(user.id);
    let conversation = await this.conversations
      .findOne({ buyerId, sellerId, productId: productId ?? null, orderId: null })
      .sort({ createdAt: -1 })
      .lean<Lean<Conversation>>();
    if (!conversation) {
      const created = await this.conversations.create({ buyerId, sellerId, productId, subject, lastMessage: { preview: '', at: new Date() } });
      conversation = created.toObject() as Lean<Conversation>;
      if (productId) await this.products.incrementInquiries(productId);
    }
    if (input.body?.trim()) {
      await this.post(conversation, {
        senderId: new Types.ObjectId(user.id),
        senderRole: 'buyer',
        senderName: user.firstName,
        kind: productId ? 'product' : 'text',
        body: input.body.trim(),
        product: productId && subject ? { productId, title: subject.title, price, image: subject.image } : undefined,
      });
      conversation = (await this.conversations.findById(conversation._id).lean<Lean<Conversation>>())!;
    }
    return this.buildDetail(conversation, user.id);
  }

  /** The thread an escrow order lives in: the buyer's open enquiry about the item, or a new one. */
  async ensureForOrder(order: Lean<Order>): Promise<Lean<Conversation>> {
    if (order.conversationId) {
      const existing = await this.conversations.findById(order.conversationId).lean<Lean<Conversation>>();
      if (existing) return existing;
    }
    const item = order.items[0];
    const linked = await this.conversations
      .findOneAndUpdate(
        { buyerId: order.buyerId, sellerId: order.sellerId, productId: item?.productId, orderId: null },
        { $set: { orderId: order._id } },
        { returnDocument: 'after', sort: { createdAt: -1 } },
      )
      .lean<Lean<Conversation>>();
    let conversation = linked;
    if (!conversation) {
      const product = item ? await this.products.findById(item.productId) : null;
      const created = await this.conversations.create({
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        productId: item?.productId,
        orderId: order._id,
        subject: item ? { title: item.title, summary: product?.summary ?? '', image: item.image, price: item.price } : undefined,
        lastMessage: { preview: '', at: new Date() },
      });
      conversation = created.toObject() as Lean<Conversation>;
    }
    await this.orders.updateOne({ _id: order._id }, { $set: { conversationId: conversation._id } });
    return conversation;
  }

  /* --- Posting ------------------------------------------------------------------------- */

  /** Writes a message, bumps unread for whoever did not send it, and pushes it live. */
  private async post(
    conversation: Lean<Conversation>,
    input: {
      senderId?: Types.ObjectId;
      senderRole: Lean<Message>['senderRole'];
      senderName: string;
      kind: MessageKind;
      body?: string;
      systemLead?: string;
      media?: Lean<Message>['media'];
      product?: Lean<Message>['product'];
      offerId?: Types.ObjectId;
      meetup?: MessageMeetup;
      dispute?: { by: string; reason: string };
    },
  ): Promise<Lean<Message>> {
    const created = await this.messages.create({
      conversationId: conversation._id,
      senderId: input.senderId,
      senderRole: input.senderRole,
      kind: input.kind,
      body: input.body ?? '',
      systemLead: input.systemLead,
      media: input.media,
      product: input.product,
      offerId: input.offerId,
      meetup: input.meetup,
      dispute: input.dispute,
    });
    const message = created.toObject() as Lean<Message>;
    const preview = this.previewOf(message);
    const fromBuyer = input.senderRole === 'buyer';
    const fromSeller = input.senderRole === 'seller';
    await this.conversations.updateOne(
      { _id: conversation._id },
      {
        $set: { lastMessage: { preview, kind: message.kind, at: message.createdAt, senderId: input.senderId } },
        $inc: { buyerUnread: fromBuyer ? 0 : 1, sellerUnread: fromSeller ? 0 : 1 },
      },
    );
    const updated = (await this.conversations.findById(conversation._id).lean<Lean<Conversation>>())!;

    const buyerId = String(conversation.buyerId);
    const sellerId = String(conversation.sellerId);
    this.realtime.toUser(buyerId, SERVER_EVENTS.messageNew, { conversationId: String(conversation._id), message: toMessageView(message, buyerId) });
    this.realtime.toUser(sellerId, SERVER_EVENTS.messageNew, { conversationId: String(conversation._id), message: toMessageView(message, sellerId) });
    for (const viewer of [buyerId, sellerId]) {
      const [summary] = await this.summaries([updated], viewer);
      this.realtime.toUser(viewer, SERVER_EVENTS.conversationUpdated, summary);
    }
    if (updated.disputeId) {
      this.realtime.toAllStaff(SERVER_EVENTS.disputeMessage, { disputeId: String(updated.disputeId), conversationId: String(updated._id), messageId: String(message._id) });
    }
    const recipients = [buyerId, sellerId].filter((id) => !input.senderId || id !== String(input.senderId));
    this.events.publish<ConversationMessageEvent>(CONVERSATION_EVENTS.message, { conversation: updated, message, recipientIds: recipients, senderName: input.senderName });
    return message;
  }

  private previewOf(message: Lean<Message>): string {
    if (message.kind === 'system') return message.systemLead ?? message.body;
    if (message.body) return excerpt(message.body, 80);
    switch (message.kind) {
      case 'image':
        return 'Sent a photo';
      case 'video':
        return 'Sent a video';
      case 'file':
        return 'Sent a file';
      case 'product':
        return 'Sent an offer';
      case 'meetup':
        return 'Proposed a meetup';
      default:
        return '';
    }
  }

  async send(user: AuthUser, conversationId: string, input: { kind?: UserMessageKind; body?: string; mediaUrl?: string }): Promise<MessageView> {
    const { role, conversation } = await this.participant(user, conversationId);
    const kind = input.kind ?? 'text';
    const body = input.body?.trim() ?? '';
    let media: Lean<Message>['media'];
    if (kind === 'text') {
      if (!body) throw Errors.badRequest('Write a message first.', 'VALIDATION_FAILED');
    } else {
      if (!input.mediaUrl) throw Errors.badRequest('Attach a file to send.', 'VALIDATION_FAILED');
      await this.media.assertOwnedUrls([input.mediaUrl], { id: user.id, type: 'user' }, ['message', 'evidence']);
      const record = await this.media.byUrl(input.mediaUrl);
      if (record && record.kind !== kind) throw Errors.badRequest(`That attachment is a ${record.kind}, not a ${kind}.`, 'VALIDATION_FAILED');
      media = { url: input.mediaUrl, posterUrl: record?.posterUrl, name: record?.name, size: record?.size, format: record?.mimeType.split('/')[1]?.toUpperCase() };
    }
    const message = await this.post(conversation, { senderId: new Types.ObjectId(user.id), senderRole: role, senderName: user.firstName, kind, body, media });
    return toMessageView(message, user.id);
  }

  async markRead(user: AuthUser, conversationId: string): Promise<{ read: true }> {
    const { role, conversation } = await this.participant(user, conversationId);
    const now = new Date();
    await this.conversations.updateOne(
      { _id: conversation._id },
      { $set: role === 'buyer' ? { buyerUnread: 0, buyerReadAt: now } : { sellerUnread: 0, sellerReadAt: now } },
    );
    const counterpart = role === 'buyer' ? String(conversation.sellerId) : String(conversation.buyerId);
    this.realtime.toUser(counterpart, SERVER_EVENTS.conversationRead, { conversationId, readerId: user.id, at: now.toISOString() });
    return { read: true };
  }

  /** A centred status line, written by the platform. */
  async postSystem(conversationId: Types.ObjectId, line: { lead: string; body: string }): Promise<void> {
    const conversation = await this.conversations.findById(conversationId).lean<Lean<Conversation>>();
    if (!conversation) return;
    await this.post(conversation, { senderRole: 'system', senderName: 'DOOAA', kind: 'system', systemLead: line.lead, body: line.body });
  }

  /** DOOAA support speaking in a disputed thread. */
  async postAdmin(conversationId: Types.ObjectId, staff: AuthStaff, body: string, mediaUrl?: string): Promise<Lean<Message>> {
    const conversation = await this.conversations.findById(conversationId).lean<Lean<Conversation>>();
    if (!conversation) throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
    return this.post(conversation, {
      senderId: new Types.ObjectId(staff.id),
      senderRole: 'staff',
      senderName: 'DOOAA Support',
      kind: 'admin',
      body,
      media: mediaUrl ? { url: mediaUrl } : undefined,
    });
  }

  /** The red dispute panel, posted when a buyer raises one. */
  async postDispute(conversationId: Types.ObjectId, user: AuthUser, reason: string, evidence?: string): Promise<void> {
    const conversation = await this.conversations.findById(conversationId).lean<Lean<Conversation>>();
    if (!conversation) return;
    const role = String(conversation.buyerId) === user.id ? 'buyer' : 'seller';
    if (evidence) {
      await this.post(conversation, { senderId: new Types.ObjectId(user.id), senderRole: role, senderName: user.firstName, kind: 'image', body: reason, media: { url: evidence } });
    }
    await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: role,
      senderName: user.firstName,
      kind: 'dispute',
      dispute: { by: role === 'buyer' ? 'Buyer' : 'Seller', reason },
    });
  }

  async linkDispute(conversationId: Types.ObjectId, disputeId: Types.ObjectId): Promise<void> {
    await this.conversations.updateOne({ _id: conversationId }, { $set: { disputeId } });
  }

  /** Raw thread for the console's dispute pane. */
  async threadFor(conversationId: Types.ObjectId): Promise<Lean<Message>[]> {
    return this.messages.find({ conversationId }).sort({ createdAt: 1, _id: 1 }).limit(500).lean<Lean<Message>[]>();
  }

  /* --- Offers ---------------------------------------------------------------------- */

  async makeOffer(user: AuthUser, conversationId: string, input: { amount: number; note?: string }): Promise<ConversationDetail> {
    const { role, conversation } = await this.participant(user, conversationId);
    if (role !== 'buyer') throw Errors.forbidden('Only the buyer can make an offer.', 'NOT_BUYER');
    if (conversation.orderId) throw Errors.conflict('This item has already been paid for.', 'ORDER_EXISTS');
    if (!conversation.productId) throw Errors.badRequest('Offers are made on a listing.', 'NO_LISTING');
    const product = await this.products.findPublic(String(conversation.productId));
    if (product.pricing !== 'negotiable') throw Errors.conflict('This item has a fixed price.', 'FIXED_PRICE');
    await this.offers.updateMany({ conversationId: conversation._id, buyerId: new Types.ObjectId(user.id), status: { $in: ['pending', 'countered'] } }, { $set: { status: 'withdrawn', respondedAt: new Date() } });
    const offer = await this.offers.create({
      conversationId: conversation._id,
      productId: product._id,
      buyerId: new Types.ObjectId(user.id),
      sellerId: product.sellerId,
      amount: input.amount,
      listed: product.price,
      note: input.note ?? '',
      status: 'pending',
    });
    await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: 'buyer',
      senderName: user.firstName,
      kind: 'product',
      body: input.note?.trim() || "I'd like to offer this amount for the item.",
      product: { productId: product._id, title: product.title, price: input.amount, image: product.images[0] ?? '' },
      offerId: offer._id,
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: offer.toObject() as Lean<Offer>, action: 'made', actorId: user.id, recipientId: String(conversation.sellerId) });
    return this.detail(user, conversationId);
  }

  private async offerFor(user: AuthUser, offerId: string): Promise<{ offer: Lean<Offer>; conversation: Lean<Conversation>; role: 'buyer' | 'seller' }> {
    if (!Types.ObjectId.isValid(offerId)) throw Errors.notFound('That offer does not exist.', 'OFFER_NOT_FOUND');
    const offer = await this.offers.findById(offerId).lean<Lean<Offer>>();
    if (!offer) throw Errors.notFound('That offer does not exist.', 'OFFER_NOT_FOUND');
    const { role, conversation } = await this.participant(user, String(offer.conversationId));
    return { offer, conversation, role };
  }

  /**
   * The seller accepts a pending offer, or the buyer accepts the seller's
   * counter. Either way the agreed price is what escrow checkout charges.
   */
  async acceptOffer(user: AuthUser, offerId: string): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    let agreed: number;
    if (role === 'seller' && offer.status === 'pending') agreed = offer.amount;
    else if (role === 'buyer' && offer.status === 'countered' && offer.counter) agreed = offer.counter.amount;
    else throw Errors.conflict('This offer is not waiting on you.', 'OFFER_NOT_PENDING');
    const updated = await this.offers
      .findOneAndUpdate({ _id: offer._id, status: offer.status }, { $set: { status: 'accepted', agreedAmount: agreed, respondedAt: new Date() } }, { returnDocument: 'after' })
      .lean<Lean<Offer>>();
    if (!updated) throw Errors.conflict('This offer has already been answered.', 'OFFER_NOT_PENDING');
    await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: role,
      senderName: user.firstName,
      kind: 'system',
      systemLead: 'Offer accepted.',
      body: `${formatNaira(agreed)} was agreed. The buyer can now pay through escrow.`,
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: updated, action: 'accepted', actorId: user.id, recipientId: role === 'seller' ? String(offer.buyerId) : String(offer.sellerId) });
    return this.detail(user, String(conversation._id));
  }

  async declineOffer(user: AuthUser, offerId: string): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    const allowed = (role === 'seller' && offer.status === 'pending') || (role === 'buyer' && offer.status === 'countered');
    if (!allowed) throw Errors.conflict('This offer is not waiting on you.', 'OFFER_NOT_PENDING');
    const updated = await this.offers
      .findOneAndUpdate({ _id: offer._id, status: offer.status }, { $set: { status: 'declined', respondedAt: new Date() } }, { returnDocument: 'after' })
      .lean<Lean<Offer>>();
    if (!updated) throw Errors.conflict('This offer has already been answered.', 'OFFER_NOT_PENDING');
    await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: role,
      senderName: user.firstName,
      kind: 'system',
      systemLead: 'Offer declined.',
      body: role === 'seller' ? 'The listing stays at its asking price.' : 'The buyer declined the counter offer.',
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: updated, action: 'declined', actorId: user.id, recipientId: role === 'seller' ? String(offer.buyerId) : String(offer.sellerId) });
    return this.detail(user, String(conversation._id));
  }

  async counterOffer(user: AuthUser, offerId: string, input: { amount: number; note?: string }): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    if (role !== 'seller' || offer.status !== 'pending') throw Errors.conflict('Only the seller can counter a pending offer.', 'OFFER_NOT_PENDING');
    const updated = await this.offers
      .findOneAndUpdate(
        { _id: offer._id, status: 'pending' },
        { $set: { status: 'countered', counter: { amount: input.amount, note: input.note ?? '', at: new Date() }, respondedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Offer>>();
    if (!updated) throw Errors.conflict('This offer has already been answered.', 'OFFER_NOT_PENDING');
    await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: 'seller',
      senderName: user.firstName,
      kind: 'system',
      systemLead: 'Counter offer sent.',
      body: `${formatNaira(input.amount)} proposed.${input.note ? ` “${input.note}”` : ''}`,
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: updated, action: 'countered', actorId: user.id, recipientId: String(offer.buyerId) });
    return this.detail(user, String(conversation._id));
  }

  async withdrawOffer(user: AuthUser, offerId: string): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    if (role !== 'buyer' || !['pending', 'countered'].includes(offer.status)) throw Errors.conflict('This offer cannot be withdrawn.', 'OFFER_NOT_PENDING');
    await this.offers.updateOne({ _id: offer._id }, { $set: { status: 'withdrawn', respondedAt: new Date() } });
    await this.post(conversation, { senderId: new Types.ObjectId(user.id), senderRole: 'buyer', senderName: user.firstName, kind: 'system', systemLead: 'Offer withdrawn.', body: 'The buyer withdrew their offer.' });
    return this.detail(user, String(conversation._id));
  }

  /* --- Meetups ---------------------------------------------------------------------- */

  async proposeMeetup(user: AuthUser, conversationId: string, input: { place: string; date: string; from: string; to: string; photo?: string }): Promise<MessageView> {
    const { role, conversation } = await this.participant(user, conversationId);
    if (input.from >= input.to) throw Errors.badRequest('The meetup should end after it starts.', 'VALIDATION_FAILED');
    const today = new Date().toISOString().slice(0, 10);
    if (input.date < today) throw Errors.badRequest('Pick a day that has not passed.', 'VALIDATION_FAILED');
    if (input.photo) await this.media.assertOwnedUrls([input.photo], { id: user.id, type: 'user' }, ['meetup', 'message']);
    const message = await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: role,
      senderName: user.firstName,
      kind: 'meetup',
      body: "I've proposed a meetup. Let me know if this works for you.",
      meetup: { venue: input.place, address: input.place, date: input.date, from: input.from, to: input.to, photo: input.photo, status: 'proposed' },
    });
    return toMessageView(message, user.id);
  }

  async respondToMeetup(user: AuthUser, conversationId: string, messageId: string, status: 'accepted' | 'declined'): Promise<MessageView> {
    const { role, conversation } = await this.participant(user, conversationId);
    if (!Types.ObjectId.isValid(messageId)) throw Errors.notFound('That meetup does not exist.', 'MEETUP_NOT_FOUND');
    const proposal = await this.messages.findOne({ _id: messageId, conversationId: conversation._id, kind: 'meetup' }).lean<Lean<Message>>();
    if (!proposal?.meetup) throw Errors.notFound('That meetup does not exist.', 'MEETUP_NOT_FOUND');
    if (proposal.senderId && String(proposal.senderId) === user.id) throw Errors.forbidden('The other side answers your proposal.', 'OWN_PROPOSAL');
    const updated = await this.messages
      .findOneAndUpdate(
        { _id: proposal._id, 'meetup.status': 'proposed' },
        { $set: { 'meetup.status': status, 'meetup.respondedAt': new Date() } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Message>>();
    if (!updated) throw Errors.conflict('This meetup has already been answered.', 'MEETUP_ANSWERED');
    const view = toMessageView(updated, user.id);
    for (const viewer of [String(conversation.buyerId), String(conversation.sellerId)]) {
      this.realtime.toUser(viewer, SERVER_EVENTS.messageUpdated, { conversationId, message: toMessageView(updated, viewer) });
    }
    await this.post(conversation, {
      senderId: new Types.ObjectId(user.id),
      senderRole: role,
      senderName: user.firstName,
      kind: 'system',
      systemLead: status === 'accepted' ? 'Meetup confirmed.' : 'Meetup declined.',
      body: status === 'accepted' ? `${view.meetup!.venue} · ${view.meetup!.day}, ${view.meetup!.window}` : 'Suggest another time and place.',
    });
    return view;
  }

  /* --- Orders in the thread ------------------------------------------------------- */

  private async onOrderUpdated(event: OrderUpdated): Promise<void> {
    const line = SYSTEM_LINES[event.event];
    let conversationId = event.order.conversationId;
    if (event.event === 'paid') conversationId = (await this.ensureForOrder(event.order))._id;
    if (!conversationId) {
      const conversation = await this.conversations.findOne({ orderId: event.order._id }).select('_id').lean();
      conversationId = conversation?._id;
    }
    if (!conversationId) return;
    if (line) await this.postSystem(conversationId, line(event.order, event.note));
    const summary = { orderId: event.order.reference, status: event.order.status, phase: event.order.escrow?.phase ?? null };
    this.realtime.toUsers([String(event.order.buyerId), String(event.order.sellerId)], SERVER_EVENTS.orderUpdated, summary);
  }
}
