import { Injectable, OnModuleInit } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql, sum, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { MessageKind, SenderRole, UserMessageKind } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { formatNaira } from '../../common/util/money';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { excerpt } from '../../common/util/text';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { conversations, messages, offers, orderItems, orders, users, type ConversationSubject, type MessageMeetup } from '../../database/schema';
import { containsText, descNullsLast } from '../../database/sql';
import { MediaService } from '../media/media.service';
import { toOrder, type Order } from '../orders/order.model';
import { ORDER_EVENTS, type OrderUpdated } from '../orders/orders.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { ProductsService } from '../products/products.service';
import { SERVER_EVENTS } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { UsersService } from '../users/users.service';
import { toConversation, type Conversation, type Message, type Offer } from './conversation.model';
import {
  ESCROW_LABEL,
  toConversationEscrow,
  toMessageView,
  toOfferView,
  type ConversationDetail,
  type ConversationSummary,
  type MessageView,
} from './conversation.presenter';

export const CONVERSATION_EVENTS = {
  message: 'conversation.message',
  offer: 'conversation.offer',
} as const;

export type ConversationMessageEvent = { conversation: Conversation; message: Message; recipientIds: string[]; senderName: string };
export type ConversationOfferEvent = { conversation: Conversation; offer: Offer; action: 'made' | 'accepted' | 'declined' | 'countered' | 'withdrawn'; actorId: string; recipientId: string };

type Participant = { role: 'buyer' | 'seller'; conversation: Conversation };

type NewMessage = {
  senderId?: string;
  senderRole: SenderRole;
  senderName: string;
  kind: MessageKind;
  body?: string;
  systemLead?: string;
  media?: Message['media'];
  product?: Message['product'];
  offerId?: string;
  meetup?: MessageMeetup;
  dispute?: { by: string; reason: string };
};

const SYSTEM_LINES: Partial<Record<OrderUpdated['event'], (order: Order, note?: string) => { lead: string; body: string }>> = {
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
    @InjectDb() private readonly db: Database,
    private readonly users: UsersService,
    private readonly products: ProductsService,
    private readonly media: MediaService,
    private readonly methods: PaymentMethodsService,
    private readonly realtime: RealtimeService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<OrderUpdated>(ORDER_EVENTS.updated, (event) => this.onOrderUpdated(event));
  }

  /* --- Loading -------------------------------------------------------------------- */

  async findById(id: string): Promise<Conversation | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id));
    return row ? toConversation(row) : null;
  }

  private async update(id: string, set: PgUpdateSetSource<typeof conversations>): Promise<Conversation> {
    const [row] = await this.db.update(conversations).set(set).where(eq(conversations.id, id)).returning();
    return toConversation(row);
  }

  /* --- Access --------------------------------------------------------------------- */

  async participant(user: { id: string }, conversationId: string): Promise<Participant> {
    const conversation = await this.findById(conversationId);
    if (!conversation) throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
    if (conversation.buyerId === user.id) return { role: 'buyer', conversation };
    if (conversation.sellerId === user.id) return { role: 'seller', conversation };
    throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
  }

  async isParticipant(userId: string, conversationId: string): Promise<boolean> {
    if (!isUuid(conversationId) || !isUuid(userId)) return false;
    const [row] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), or(eq(conversations.buyerId, userId), eq(conversations.sellerId, userId))));
    return Boolean(row);
  }

  /* --- Views ---------------------------------------------------------------------- */

  private async summaries(rows: Conversation[], viewerId: string): Promise<ConversationSummary[]> {
    if (!rows.length) return [];
    const counterpartIds = rows.map((row) => (row.buyerId === viewerId ? row.sellerId : row.buyerId));
    const orderIds = rows.map((row) => row.orderId).filter((id): id is string => Boolean(id));
    const [people, orderRows, openOffers] = await Promise.all([
      this.users.findByIds([...counterpartIds, ...rows.map((row) => row.buyerId)]),
      orderIds.length ? this.db.select({ id: orders.id, reference: orders.reference, escrowPhase: orders.escrowPhase }).from(orders).where(inArray(orders.id, orderIds)) : [],
      this.db
        .select()
        .from(offers)
        .where(
          and(
            inArray(
              offers.conversationId,
              rows.map((row) => row.id),
            ),
            inArray(offers.status, ['pending', 'countered', 'accepted']),
          ),
        )
        .orderBy(desc(offers.createdAt)),
    ]);
    const personById = new Map(people.map((person) => [person.id, person]));
    const orderById = new Map(orderRows.map((order) => [order.id, order]));
    const offerByConversation = new Map<string, Offer>();
    for (const offer of openOffers) if (!offerByConversation.has(offer.conversationId)) offerByConversation.set(offer.conversationId, offer);

    return rows.map((row) => {
      const viewerRole: 'buyer' | 'seller' = row.buyerId === viewerId ? 'buyer' : 'seller';
      const counterpartId = viewerRole === 'buyer' ? row.sellerId : row.buyerId;
      const person = personById.get(counterpartId);
      const order = row.orderId ? orderById.get(row.orderId) : undefined;
      const offer = offerByConversation.get(row.id);
      const name = person ? `${person.firstName} ${person.lastName}`.trim() : 'DOOAA member';
      const verified = person?.identity === 'verified';
      return {
        id: row.id,
        viewerRole,
        counterpart: {
          id: counterpartId,
          name,
          avatarUrl: person?.avatarUrl ?? null,
          storeName: person?.seller.storeName ?? null,
          verified,
          online: this.realtime.isOnline(counterpartId),
        },
        name,
        store: viewerRole === 'buyer' ? (person?.seller.storeName ?? null) : 'Buyer',
        verified: viewerRole === 'buyer' ? verified : false,
        productId: row.productId,
        subject: row.subject ? { title: row.subject.title, summary: row.subject.summary, image: row.subject.image, price: row.subject.price } : null,
        preview: row.lastMessage.preview,
        lastMessageAt: (row.lastMessage.at ?? row.updatedAt).toISOString(),
        unread: viewerRole === 'buyer' ? row.buyerUnread : row.sellerUnread,
        escrow: order?.escrowPhase ? { orderId: order.reference, phase: order.escrowPhase, status: ESCROW_LABEL[order.escrowPhase] } : null,
        offer: offer ? toOfferView(offer, personById.get(row.buyerId) ?? null, row.subject ?? undefined) : null,
      };
    });
  }

  async list(user: AuthUser, query: { filter?: 'all' | 'unread'; q?: string; page?: number; limit?: number }): Promise<Page<ConversationSummary>> {
    const conditions: SQL[] = [
      query.filter === 'unread'
        ? or(and(eq(conversations.buyerId, user.id), gt(conversations.buyerUnread, 0)), and(eq(conversations.sellerId, user.id), gt(conversations.sellerUnread, 0)))!
        : or(eq(conversations.buyerId, user.id), eq(conversations.sellerId, user.id))!,
    ];
    const term = query.q?.trim();
    if (term) {
      const people = this.db
        .select({ id: users.id })
        .from(users)
        .where(or(containsText(users.firstName, term), containsText(users.lastName, term), containsText(users.sellerStoreName, term)));
      conditions.push(
        or(
          containsText(sql`${conversations.subject}->>'title'`, term),
          containsText(conversations.lastMessagePreview, term),
          inArray(conversations.buyerId, people),
          inArray(conversations.sellerId, people),
        )!,
      );
    }
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(conversations).where(where);
    const window = pageWindow(total, query.page, query.limit ?? 30);
    const rows = await this.db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(descNullsLast(conversations.lastMessageAt), desc(conversations.updatedAt))
      .offset(window.skip)
      .limit(window.size);
    return toPage(await this.summaries(rows.map(toConversation), user.id), total, window);
  }

  async detail(user: AuthUser, conversationId: string): Promise<ConversationDetail> {
    const { conversation } = await this.participant(user, conversationId);
    return this.buildDetail(conversation, user.id);
  }

  async buildDetail(conversation: Conversation, viewerId: string): Promise<ConversationDetail> {
    const [summary] = await this.summaries([conversation], viewerId);
    const { messages: thread, hasMore } = await this.page(conversation.id, viewerId, {});
    let escrow = null;
    const order = conversation.orderId ? await this.orderOf(conversation.orderId) : null;
    if (order) {
      const [buyer, seller, payout] = await Promise.all([
        this.users.findById(order.buyerId),
        this.users.findById(order.sellerId),
        this.methods.payoutAccount(order.sellerId),
      ]);
      escrow = toConversationEscrow(order, buyer, seller, payout?.last4);
    }
    return { ...summary, escrow, messages: thread, hasMore };
  }

  /** The order a thread follows, with its items, for the escrow panel. */
  private async orderOf(orderId: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, orderId));
    if (!row) return null;
    const items = await this.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    return toOrder(row, items);
  }

  private async page(conversationId: string, viewerId: string, query: { before?: string; limit?: number }): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const limit = Math.min(query.limit ?? 50, 100);
    const conditions: SQL[] = [eq(messages.conversationId, conversationId)];
    if (query.before && isUuid(query.before)) {
      const [pivot] = await this.db.select({ id: messages.id, createdAt: messages.createdAt }).from(messages).where(eq(messages.id, query.before));
      if (pivot) conditions.push(or(lt(messages.createdAt, pivot.createdAt), and(eq(messages.createdAt, pivot.createdAt), lt(messages.id, pivot.id)))!);
    }
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    return {
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((row) => toMessageView(row, viewerId)),
      hasMore,
    };
  }

  async messagesPage(user: AuthUser, conversationId: string, query: { before?: string; limit?: number }) {
    const { conversation } = await this.participant(user, conversationId);
    return this.page(conversation.id, user.id, query);
  }

  async unreadCount(userId: string): Promise<{ threads: number; messages: number }> {
    const [[asBuyer], [asSeller]] = await Promise.all([
      this.db
        .select({ threads: count(), messages: sum(conversations.buyerUnread).mapWith(Number) })
        .from(conversations)
        .where(and(eq(conversations.buyerId, userId), gt(conversations.buyerUnread, 0))),
      this.db
        .select({ threads: count(), messages: sum(conversations.sellerUnread).mapWith(Number) })
        .from(conversations)
        .where(and(eq(conversations.sellerId, userId), gt(conversations.sellerUnread, 0))),
    ]);
    return {
      threads: asBuyer.threads + asSeller.threads,
      messages: (asBuyer.messages ?? 0) + (asSeller.messages ?? 0),
    };
  }

  /* --- Starting threads ---------------------------------------------------------------- */

  /**
   * "Message seller" from a listing (or a seller's page). Reuses the open
   * thread about the same listing rather than starting another.
   */
  async start(user: AuthUser, input: { productId?: string; sellerId?: string; body?: string }): Promise<ConversationDetail> {
    let sellerId: string;
    let productId: string | null = null;
    let subject: ConversationSubject | null = null;
    let price = 0;
    if (input.productId) {
      const product = await this.products.findPublic(input.productId);
      sellerId = product.sellerId;
      productId = product.id;
      price = product.price;
      subject = { title: product.title, summary: product.summary || excerpt(product.description, 160), image: product.images[0] ?? '', price: product.price };
    } else if (input.sellerId && isUuid(input.sellerId)) {
      sellerId = input.sellerId;
      const seller = await this.users.findById(sellerId);
      if (!seller || seller.status === 'closed' || seller.status === 'banned') throw Errors.notFound('That seller is not on DOOAA.', 'SELLER_NOT_FOUND');
    } else {
      throw Errors.badRequest('Choose a listing or a seller to message.', 'VALIDATION_FAILED');
    }
    if (sellerId === user.id) throw Errors.forbidden('You cannot message yourself.', 'OWN_LISTING');

    const [existing] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.buyerId, user.id),
          eq(conversations.sellerId, sellerId),
          productId ? eq(conversations.productId, productId) : isNull(conversations.productId),
          isNull(conversations.orderId),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    let conversation = existing ? toConversation(existing) : null;
    if (!conversation) {
      const [created] = await this.db
        .insert(conversations)
        .values({ buyerId: user.id, sellerId, productId, subject, lastMessageAt: new Date() })
        .returning();
      conversation = toConversation(created);
      if (productId) await this.products.incrementInquiries(productId);
    }
    if (input.body?.trim()) {
      await this.post(conversation, {
        senderId: user.id,
        senderRole: 'buyer',
        senderName: user.firstName,
        kind: productId ? 'product' : 'text',
        body: input.body.trim(),
        product: productId && subject ? { productId, title: subject.title, price, image: subject.image } : undefined,
      });
      conversation = (await this.findById(conversation.id))!;
    }
    return this.buildDetail(conversation, user.id);
  }

  /** The thread an escrow order lives in: the buyer's open enquiry about the item, or a new one. */
  async ensureForOrder(order: Order): Promise<Conversation> {
    if (order.conversationId) {
      const existing = await this.findById(order.conversationId);
      if (existing) return existing;
    }
    const item = order.items[0];
    let conversation: Conversation | null = null;
    if (item) {
      // Adopt the buyer's latest open enquiry about the item.
      const [linked] = await this.db
        .update(conversations)
        .set({ orderId: order.id })
        .where(
          inArray(
            conversations.id,
            this.db
              .select({ id: conversations.id })
              .from(conversations)
              .where(
                and(
                  eq(conversations.buyerId, order.buyerId),
                  eq(conversations.sellerId, order.sellerId),
                  eq(conversations.productId, item.productId),
                  isNull(conversations.orderId),
                ),
              )
              .orderBy(desc(conversations.createdAt))
              .limit(1),
          ),
        )
        .returning();
      conversation = linked ? toConversation(linked) : null;
    }
    if (!conversation) {
      const product = item ? await this.products.findById(item.productId) : null;
      const [created] = await this.db
        .insert(conversations)
        .values({
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          productId: item?.productId ?? null,
          orderId: order.id,
          subject: item ? { title: item.title, summary: product?.summary ?? '', image: item.image, price: item.price } : null,
          lastMessageAt: new Date(),
        })
        .returning();
      conversation = toConversation(created);
    }
    await this.db.update(orders).set({ conversationId: conversation.id }).where(eq(orders.id, order.id));
    return conversation;
  }

  /* --- Posting ------------------------------------------------------------------------- */

  /** Writes a message, bumps unread for whoever did not send it, and pushes it live. */
  private async post(conversation: Conversation, input: NewMessage): Promise<Message> {
    const [message] = await this.db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        senderId: input.senderId ?? null,
        senderRole: input.senderRole,
        kind: input.kind,
        body: input.body ?? '',
        systemLead: input.systemLead ?? null,
        media: input.media ?? null,
        product: input.product ?? null,
        offerId: input.offerId ?? null,
        meetup: input.meetup ?? null,
        dispute: input.dispute ?? null,
      })
      .returning();
    const fromBuyer = input.senderRole === 'buyer';
    const fromSeller = input.senderRole === 'seller';
    const updated = await this.update(conversation.id, {
      lastMessagePreview: this.previewOf(message),
      lastMessageKind: message.kind,
      lastMessageAt: message.createdAt,
      lastMessageSenderId: input.senderId ?? null,
      buyerUnread: sql`${conversations.buyerUnread} + ${fromBuyer ? 0 : 1}`,
      sellerUnread: sql`${conversations.sellerUnread} + ${fromSeller ? 0 : 1}`,
    });

    const { buyerId, sellerId } = conversation;
    this.realtime.toUser(buyerId, SERVER_EVENTS.messageNew, { conversationId: conversation.id, message: toMessageView(message, buyerId) });
    this.realtime.toUser(sellerId, SERVER_EVENTS.messageNew, { conversationId: conversation.id, message: toMessageView(message, sellerId) });
    for (const viewer of [buyerId, sellerId]) {
      const [summary] = await this.summaries([updated], viewer);
      this.realtime.toUser(viewer, SERVER_EVENTS.conversationUpdated, summary);
    }
    if (updated.disputeId) {
      this.realtime.toAllStaff(SERVER_EVENTS.disputeMessage, { disputeId: updated.disputeId, conversationId: updated.id, messageId: message.id });
    }
    const recipients = [buyerId, sellerId].filter((id) => !input.senderId || id !== input.senderId);
    this.events.publish<ConversationMessageEvent>(CONVERSATION_EVENTS.message, { conversation: updated, message, recipientIds: recipients, senderName: input.senderName });
    return message;
  }

  private previewOf(message: Message): string {
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
    let media: Message['media'] = null;
    if (kind === 'text') {
      if (!body) throw Errors.badRequest('Write a message first.', 'VALIDATION_FAILED');
    } else {
      if (!input.mediaUrl) throw Errors.badRequest('Attach a file to send.', 'VALIDATION_FAILED');
      await this.media.assertOwnedUrls([input.mediaUrl], { id: user.id, type: 'user' }, ['message', 'evidence']);
      const record = await this.media.byUrl(input.mediaUrl);
      if (record && record.kind !== kind) throw Errors.badRequest(`That attachment is a ${record.kind}, not a ${kind}.`, 'VALIDATION_FAILED');
      media = await this.describeMedia(input.mediaUrl);
    }
    const message = await this.post(conversation, { senderId: user.id, senderRole: role, senderName: user.firstName, kind, body, media });
    return toMessageView(message, user.id);
  }

  async markRead(user: AuthUser, conversationId: string): Promise<{ read: true }> {
    const { role, conversation } = await this.participant(user, conversationId);
    const now = new Date();
    await this.update(conversation.id, role === 'buyer' ? { buyerUnread: 0, buyerReadAt: now } : { sellerUnread: 0, sellerReadAt: now });
    const counterpart = role === 'buyer' ? conversation.sellerId : conversation.buyerId;
    this.realtime.toUser(counterpart, SERVER_EVENTS.conversationRead, { conversationId: conversation.id, readerId: user.id, at: now.toISOString() });
    return { read: true };
  }

  /** A centred status line, written by the platform. */
  async postSystem(conversationId: string, line: { lead: string; body: string }): Promise<void> {
    const conversation = await this.findById(conversationId);
    if (!conversation) return;
    await this.post(conversation, { senderRole: 'system', senderName: 'DOOAA', kind: 'system', systemLead: line.lead, body: line.body });
  }

  /** DOOAA support speaking in a disputed thread. */
  async postAdmin(conversationId: string, staff: AuthStaff, body: string, mediaUrl?: string): Promise<Message> {
    const conversation = await this.findById(conversationId);
    if (!conversation) throw Errors.notFound('That conversation does not exist.', 'CONVERSATION_NOT_FOUND');
    return this.post(conversation, {
      senderId: staff.id,
      senderRole: 'staff',
      senderName: 'DOOAA Support',
      kind: 'admin',
      body,
      media: mediaUrl ? await this.describeMedia(mediaUrl) : undefined,
    });
  }

  /** Name, size and format of an uploaded file, so the chat can show a photo or a document card. */
  private async describeMedia(url: string): Promise<NonNullable<Message['media']>> {
    const record = await this.media.byUrl(url);
    return {
      url,
      ...(record?.posterUrl ? { posterUrl: record.posterUrl } : {}),
      ...(record ? { name: record.name, size: record.size, format: record.mimeType.split('/')[1]?.toUpperCase() } : {}),
    };
  }

  /** The red dispute panel, posted when a buyer raises one. */
  async postDispute(conversationId: string, user: AuthUser, reason: string, evidence?: string): Promise<void> {
    const conversation = await this.findById(conversationId);
    if (!conversation) return;
    const role = conversation.buyerId === user.id ? 'buyer' : 'seller';
    if (evidence) {
      await this.post(conversation, { senderId: user.id, senderRole: role, senderName: user.firstName, kind: 'image', body: reason, media: { url: evidence } });
    }
    await this.post(conversation, {
      senderId: user.id,
      senderRole: role,
      senderName: user.firstName,
      kind: 'dispute',
      dispute: { by: role === 'buyer' ? 'Buyer' : 'Seller', reason },
    });
  }

  async linkDispute(conversationId: string, disputeId: string): Promise<void> {
    await this.db.update(conversations).set({ disputeId }).where(eq(conversations.id, conversationId));
  }

  /** Raw thread for the console's dispute pane. */
  async threadFor(conversationId: string): Promise<Message[]> {
    return this.db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(500);
  }

  /* --- Offers ---------------------------------------------------------------------- */

  async makeOffer(user: AuthUser, conversationId: string, input: { amount: number; note?: string }): Promise<ConversationDetail> {
    const { role, conversation } = await this.participant(user, conversationId);
    if (role !== 'buyer') throw Errors.forbidden('Only the buyer can make an offer.', 'NOT_BUYER');
    if (conversation.orderId) throw Errors.conflict('This item has already been paid for.', 'ORDER_EXISTS');
    if (!conversation.productId) throw Errors.badRequest('Offers are made on a listing.', 'NO_LISTING');
    const product = await this.products.findPublic(conversation.productId);
    if (product.pricing !== 'negotiable') throw Errors.conflict('This item has a fixed price.', 'FIXED_PRICE');
    const offer = await this.db.transaction(async (tx) => {
      await tx
        .update(offers)
        .set({ status: 'withdrawn', respondedAt: new Date() })
        .where(and(eq(offers.conversationId, conversation.id), eq(offers.buyerId, user.id), inArray(offers.status, ['pending', 'countered'])));
      const [created] = await tx
        .insert(offers)
        .values({
          conversationId: conversation.id,
          productId: product.id,
          buyerId: user.id,
          sellerId: product.sellerId,
          amount: input.amount,
          listed: product.price,
          note: input.note ?? '',
          status: 'pending',
        })
        .returning();
      return created;
    });
    await this.post(conversation, {
      senderId: user.id,
      senderRole: 'buyer',
      senderName: user.firstName,
      kind: 'product',
      body: input.note?.trim() || "I'd like to offer this amount for the item.",
      product: { productId: product.id, title: product.title, price: input.amount, image: product.images[0] ?? '' },
      offerId: offer.id,
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer, action: 'made', actorId: user.id, recipientId: conversation.sellerId });
    return this.detail(user, conversationId);
  }

  private async offerFor(user: AuthUser, offerId: string): Promise<{ offer: Offer; conversation: Conversation; role: 'buyer' | 'seller' }> {
    const [offer] = isUuid(offerId) ? await this.db.select().from(offers).where(eq(offers.id, offerId)) : [];
    if (!offer) throw Errors.notFound('That offer does not exist.', 'OFFER_NOT_FOUND');
    const { role, conversation } = await this.participant(user, offer.conversationId);
    return { offer, conversation, role };
  }

  /** Moves an offer on only if nobody answered it in the meantime. */
  private async answerOffer(offer: Offer, set: PgUpdateSetSource<typeof offers>): Promise<Offer> {
    const [updated] = await this.db
      .update(offers)
      .set(set)
      .where(and(eq(offers.id, offer.id), eq(offers.status, offer.status)))
      .returning();
    if (!updated) throw Errors.conflict('This offer has already been answered.', 'OFFER_NOT_PENDING');
    return updated;
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
    const updated = await this.answerOffer(offer, { status: 'accepted', agreedAmount: agreed, respondedAt: new Date() });
    await this.post(conversation, {
      senderId: user.id,
      senderRole: role,
      senderName: user.firstName,
      kind: 'system',
      systemLead: 'Offer accepted.',
      body: `${formatNaira(agreed)} was agreed. The buyer can now pay through escrow.`,
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: updated, action: 'accepted', actorId: user.id, recipientId: role === 'seller' ? offer.buyerId : offer.sellerId });
    return this.detail(user, conversation.id);
  }

  async declineOffer(user: AuthUser, offerId: string): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    const allowed = (role === 'seller' && offer.status === 'pending') || (role === 'buyer' && offer.status === 'countered');
    if (!allowed) throw Errors.conflict('This offer is not waiting on you.', 'OFFER_NOT_PENDING');
    const updated = await this.answerOffer(offer, { status: 'declined', respondedAt: new Date() });
    await this.post(conversation, {
      senderId: user.id,
      senderRole: role,
      senderName: user.firstName,
      kind: 'system',
      systemLead: 'Offer declined.',
      body: role === 'seller' ? 'The listing stays at its asking price.' : 'The buyer declined the counter offer.',
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: updated, action: 'declined', actorId: user.id, recipientId: role === 'seller' ? offer.buyerId : offer.sellerId });
    return this.detail(user, conversation.id);
  }

  async counterOffer(user: AuthUser, offerId: string, input: { amount: number; note?: string }): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    if (role !== 'seller' || offer.status !== 'pending') throw Errors.conflict('Only the seller can counter a pending offer.', 'OFFER_NOT_PENDING');
    const now = new Date();
    const updated = await this.answerOffer(offer, { status: 'countered', counter: { amount: input.amount, note: input.note ?? '', at: now.toISOString() }, respondedAt: now });
    await this.post(conversation, {
      senderId: user.id,
      senderRole: 'seller',
      senderName: user.firstName,
      kind: 'system',
      systemLead: 'Counter offer sent.',
      body: `${formatNaira(input.amount)} proposed.${input.note ? ` “${input.note}”` : ''}`,
    });
    this.events.publish<ConversationOfferEvent>(CONVERSATION_EVENTS.offer, { conversation, offer: updated, action: 'countered', actorId: user.id, recipientId: offer.buyerId });
    return this.detail(user, conversation.id);
  }

  async withdrawOffer(user: AuthUser, offerId: string): Promise<ConversationDetail> {
    const { offer, conversation, role } = await this.offerFor(user, offerId);
    if (role !== 'buyer' || !['pending', 'countered'].includes(offer.status)) throw Errors.conflict('This offer cannot be withdrawn.', 'OFFER_NOT_PENDING');
    await this.db.update(offers).set({ status: 'withdrawn', respondedAt: new Date() }).where(eq(offers.id, offer.id));
    await this.post(conversation, { senderId: user.id, senderRole: 'buyer', senderName: user.firstName, kind: 'system', systemLead: 'Offer withdrawn.', body: 'The buyer withdrew their offer.' });
    return this.detail(user, conversation.id);
  }

  /* --- Meetups ---------------------------------------------------------------------- */

  async proposeMeetup(user: AuthUser, conversationId: string, input: { place: string; date: string; from: string; to: string; photo?: string }): Promise<MessageView> {
    const { role, conversation } = await this.participant(user, conversationId);
    if (input.from >= input.to) throw Errors.badRequest('The meetup should end after it starts.', 'VALIDATION_FAILED');
    const today = new Date().toISOString().slice(0, 10);
    if (input.date < today) throw Errors.badRequest('Pick a day that has not passed.', 'VALIDATION_FAILED');
    if (input.photo) await this.media.assertOwnedUrls([input.photo], { id: user.id, type: 'user' }, ['meetup', 'message']);
    const message = await this.post(conversation, {
      senderId: user.id,
      senderRole: role,
      senderName: user.firstName,
      kind: 'meetup',
      body: "I've proposed a meetup. Let me know if this works for you.",
      meetup: { venue: input.place, address: input.place, date: input.date, from: input.from, to: input.to, ...(input.photo ? { photo: input.photo } : {}), status: 'proposed' },
    });
    return toMessageView(message, user.id);
  }

  async respondToMeetup(user: AuthUser, conversationId: string, messageId: string, status: 'accepted' | 'declined'): Promise<MessageView> {
    const { role, conversation } = await this.participant(user, conversationId);
    const [proposal] = isUuid(messageId)
      ? await this.db
          .select()
          .from(messages)
          .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversation.id), eq(messages.kind, 'meetup')))
      : [];
    if (!proposal?.meetup) throw Errors.notFound('That meetup does not exist.', 'MEETUP_NOT_FOUND');
    if (proposal.senderId && proposal.senderId === user.id) throw Errors.forbidden('The other side answers your proposal.', 'OWN_PROPOSAL');
    const [updated] = await this.db
      .update(messages)
      .set({ meetup: { ...proposal.meetup, status, respondedAt: new Date().toISOString() } })
      .where(and(eq(messages.id, proposal.id), sql`${messages.meetup}->>'status' = 'proposed'`))
      .returning();
    if (!updated) throw Errors.conflict('This meetup has already been answered.', 'MEETUP_ANSWERED');
    const view = toMessageView(updated, user.id);
    for (const viewer of [conversation.buyerId, conversation.sellerId]) {
      this.realtime.toUser(viewer, SERVER_EVENTS.messageUpdated, { conversationId: conversation.id, message: toMessageView(updated, viewer) });
    }
    await this.post(conversation, {
      senderId: user.id,
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
    if (event.event === 'paid') conversationId = (await this.ensureForOrder(event.order)).id;
    if (!conversationId) {
      const [conversation] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.orderId, event.order.id)).limit(1);
      conversationId = conversation?.id ?? null;
    }
    if (!conversationId) return;
    if (line) await this.postSystem(conversationId, line(event.order, event.note));
    const summary = { orderId: event.order.reference, status: event.order.status, phase: event.order.escrow?.phase ?? null };
    this.realtime.toUsers([event.order.buyerId, event.order.sellerId], SERVER_EVENTS.orderUpdated, summary);
  }
}
