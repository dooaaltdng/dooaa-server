import { sql } from 'drizzle-orm';
import { boolean, char, check, index, integer, jsonb, numeric, pgTable, smallint, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { money, primaryId, timestamps, timestamptz } from './columns';
import {
  checkoutMethod,
  disputeOutcome,
  disputeParty,
  disputeState,
  escrowPhase,
  escrowStatus,
  messageKind,
  offerStatus,
  orderActor,
  orderKind,
  orderPaymentStatus,
  orderStatus,
  productCondition,
  refundStatus,
  senderRole,
  settlement,
} from './enums';
import { users } from './identity';
import { products } from './catalog';
import type {
  ConversationSubject,
  DeliveryInfo,
  EscrowHistoryEntry,
  MessageDispute,
  MessageMedia,
  MessageMeetup,
  MessageProduct,
  OfferCounter,
  ReviewAspects,
  ReviewResponse,
  TimelineEntry,
} from './values';

/*
 * Orders and the conversations, offers, disputes and reviews around them.
 * They point at each other (an order knows its dispute, a dispute its order),
 * so they live in one module.
 */

/**
 * One seller's share of a checkout. The buyer's money sits with the payment
 * provider; the escrow columns record which way DOOAA has instructed it to go.
 */
export const orders = pgTable(
  'orders',
  {
    id: primaryId(),
    /** "482-301948271", also accepted in routes. The display number is "#" + this. */
    reference: text().notNull(),
    checkoutId: text().notNull(),
    buyerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: orderKind().notNull(),

    subtotal: money().notNull(),
    discount: money().notNull().default(0),
    /** Percent, e.g. 7.5. */
    taxRate: numeric({ precision: 6, scale: 3, mode: 'number' }).notNull().default(0),
    tax: money().notNull().default(0),
    shipping: money().notNull().default(0),
    escrowFee: money().notNull().default(0),
    total: money().notNull(),
    commission: money().notNull().default(0),
    /** What the seller is owed once escrow releases. */
    sellerEarning: money().notNull(),
    currency: char({ length: 3 }).notNull().default('NGN'),
    couponCode: text(),
    delivery: jsonb().$type<DeliveryInfo>().notNull(),

    /* The order's copy of its charge. */
    paymentMethod: checkoutMethod().notNull(),
    paymentReference: text(),
    paymentProvider: text(),
    paymentStatus: orderPaymentStatus().notNull().default('pending'),
    paymentPaidAt: timestamptz(),
    paymentBrand: text(),
    paymentLast4: text(),
    paymentChannel: text(),

    status: orderStatus().notNull().default('awaiting-payment'),

    /* Escrow, from the moment the charge is confirmed. */
    /** "#3588-A3849-6788" — the console ledger's reference. */
    escrowReference: text(),
    escrowPhase: escrowPhase(),
    escrowStatus: escrowStatus(),
    escrowSettlement: settlement(),
    escrowPhaseBeforeDispute: escrowPhase(),
    escrowFundedAt: timestamptz(),
    escrowShippedAt: timestamptz(),
    escrowReceivedAt: timestamptz(),
    escrowInspectionEndsAt: timestamptz(),
    escrowDisputedAt: timestamptz(),
    escrowReleasedAt: timestamptz(),
    escrowRefundedAt: timestamptz(),
    escrowSettledBy: text(),
    escrowSettledAt: timestamptz(),
    escrowHistory: jsonb().$type<EscrowHistoryEntry[]>().notNull().default([]),

    /** The seller's dispatch deadline, counted from payment. */
    shipBy: timestamptz(),
    shipmentCarrier: text(),
    shipmentTrackingNumber: text(),
    shipmentProofUrl: text(),
    shipmentNote: text(),
    shippedAt: timestamptz(),

    confirmedAt: timestamptz(),
    deliveredAt: timestamptz(),
    /** End of the return window — "until Nov 2, 2025" on delivered orders. */
    returnBy: timestamptz(),
    completedAt: timestamptz(),
    cancelledAt: timestamptz(),
    cancellationReason: text(),
    cancelledBy: orderActor(),
    /** The buyer asked to cancel after the seller confirmed. */
    cancellationRequestReason: text(),
    cancellationRequestedAt: timestamptz(),

    /* The refund DOOAA asked the provider to make, if any. */
    refundStatus: refundStatus(),
    refundAmount: money(),
    refundReference: text(),
    refundRequestedAt: timestamptz(),
    refundProcessedAt: timestamptz(),
    refundFailureReason: text(),

    timeline: jsonb().$type<TimelineEntry[]>().notNull().default([]),
    conversationId: uuid().references((): AnyPgColumn => conversations.id, { onDelete: 'set null' }),
    offerId: uuid().references((): AnyPgColumn => offers.id, { onDelete: 'set null' }),
    disputeId: uuid().references((): AnyPgColumn => disputes.id, { onDelete: 'set null' }),
    reviewId: uuid().references((): AnyPgColumn => reviews.id, { onDelete: 'set null' }),
    /** When an unpaid order lapses. */
    expiresAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('orders_reference_key').on(t.reference),
    uniqueIndex('orders_escrow_reference_key').on(t.escrowReference),
    index('orders_buyer_idx').on(t.buyerId, t.createdAt.desc()),
    index('orders_seller_idx').on(t.sellerId, t.createdAt.desc()),
    index('orders_checkout_idx').on(t.checkoutId),
    index('orders_payment_reference_idx').on(t.paymentReference),
    index('orders_status_ship_by_idx').on(t.status, t.shipBy),
    index('orders_escrow_status_idx').on(t.escrowStatus, t.escrowFundedAt.desc()),
    index('orders_escrow_inspection_idx').on(t.escrowPhase, t.escrowInspectionEndsAt),
    index('orders_expires_at_idx').on(t.expiresAt).where(sql`status = 'awaiting-payment'`),
  ],
);

/** An order line, frozen at the price and title it was bought at. */
export const orderItems = pgTable(
  'order_items',
  {
    id: primaryId(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    position: smallint().notNull(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    title: text().notNull(),
    sku: text().notNull(),
    quantity: integer().notNull(),
    price: money().notNull(),
    image: text().notNull().default(''),
    condition: productCondition(),
  },
  (t) => [
    uniqueIndex('order_items_order_position_key').on(t.orderId, t.position),
    index('order_items_product_idx').on(t.productId),
    index('order_items_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
    check('order_items_quantity_positive', sql`${t.quantity} >= 1`),
  ],
);

/** A buyer and a seller talking, usually about one listing and often one order. */
export const conversations = pgTable(
  'conversations',
  {
    id: primaryId(),
    buyerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    productId: uuid().references(() => products.id, { onDelete: 'set null' }),
    subject: jsonb().$type<ConversationSubject>(),
    /** The escrow order this thread follows, once the buyer pays. */
    orderId: uuid().references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
    disputeId: uuid().references((): AnyPgColumn => disputes.id, { onDelete: 'set null' }),
    lastMessagePreview: text().notNull().default(''),
    lastMessageKind: messageKind(),
    lastMessageAt: timestamptz(),
    /** A users.id or staff.id (staff speak in dispute threads). */
    lastMessageSenderId: uuid(),
    buyerUnread: integer().notNull().default(0),
    sellerUnread: integer().notNull().default(0),
    buyerReadAt: timestamptz(),
    sellerReadAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    index('conversations_buyer_idx').on(t.buyerId, t.lastMessageAt.desc()),
    index('conversations_seller_idx').on(t.sellerId, t.lastMessageAt.desc()),
    index('conversations_thread_idx').on(t.buyerId, t.sellerId, t.productId, t.orderId),
    index('conversations_order_idx').on(t.orderId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: primaryId(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** A users.id or staff.id; null for platform system lines. */
    senderId: uuid(),
    senderRole: senderRole().notNull(),
    kind: messageKind().notNull(),
    body: text().notNull().default(''),
    /** The highlighted lead-in on a system line ("Item marked as received."). */
    systemLead: text(),
    media: jsonb().$type<MessageMedia>(),
    product: jsonb().$type<MessageProduct>(),
    offerId: uuid().references((): AnyPgColumn => offers.id, { onDelete: 'set null' }),
    meetup: jsonb().$type<MessageMeetup>(),
    dispute: jsonb().$type<MessageDispute>(),
    ...timestamps,
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt.desc(), t.id.desc())],
);

/**
 * A price negotiated in chat. An accepted offer (or an accepted counter)
 * becomes the price "Buy via Escrow" charges that buyer.
 */
export const offers = pgTable(
  'offers',
  {
    id: primaryId(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    buyerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    amount: money().notNull(),
    /** The listing's asking price when the offer was made — "Product Price (Listed)". */
    listed: money().notNull(),
    note: text().notNull().default(''),
    status: offerStatus().notNull().default('pending'),
    counter: jsonb().$type<OfferCounter>(),
    /** The price both sides agreed, once accepted. */
    agreedAmount: money(),
    respondedAt: timestamptz(),
    orderId: uuid().references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('offers_conversation_idx').on(t.conversationId, t.createdAt.desc()),
    index('offers_buyer_product_idx').on(t.buyerId, t.productId, t.status),
  ],
);

export const disputes = pgTable(
  'disputes',
  {
    id: primaryId(),
    /** "#3790". */
    reference: text().notNull(),
    orderId: uuid()
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'restrict' }),
    conversationId: uuid().references((): AnyPgColumn => conversations.id, { onDelete: 'set null' }),
    buyerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    item: text().notNull(),
    orderValue: money().notNull(),
    orderNumber: text().notNull(),
    purchaseDate: timestamptz().notNull(),
    state: disputeState().notNull().default('active'),
    outcome: disputeOutcome(),
    openedBy: disputeParty().notNull().default('buyer'),
    /** The buyer's claim. */
    reason: text().notNull(),
    sellerClaim: text(),
    evidence: text().array().notNull().default(sql`'{}'::text[]`),
    sellerEvidence: text().array().notNull().default(sql`'{}'::text[]`),
    responseDueAt: timestamptz().notNull(),
    resolvedBy: text(),
    resolvedAt: timestamptz(),
    resolutionNote: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('disputes_reference_key').on(t.reference),
    index('disputes_order_idx').on(t.orderId),
    index('disputes_state_idx').on(t.state, t.createdAt.desc()),
    index('disputes_buyer_idx').on(t.buyerId, t.createdAt.desc()),
    index('disputes_seller_idx').on(t.sellerId, t.createdAt.desc()),
  ],
);

/**
 * "Rate your experience with …" — one per completed order, always a verified
 * purchase. The products it covers are the order's items.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: primaryId(),
    orderId: uuid()
      .notNull()
      .references((): AnyPgColumn => orders.id, { onDelete: 'cascade' }),
    buyerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rating: smallint().notNull(),
    aspects: jsonb().$type<ReviewAspects>().notNull().default({}),
    body: text().notNull().default(''),
    response: jsonb().$type<ReviewResponse>(),
    /** Hidden by moderation; kept for the record but out of every average and list. */
    hidden: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('reviews_order_key').on(t.orderId),
    index('reviews_seller_idx').on(t.sellerId, t.hidden, t.createdAt.desc()),
    check('reviews_rating_range', sql`${t.rating} between 1 and 5`),
  ],
);
