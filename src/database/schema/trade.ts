import type {
  CheckoutMethod,
  Condition,
  DisputeOutcome,
  DisputeParty,
  DisputeState,
  EscrowPhase,
  EscrowStatus,
  MessageKind,
  OfferStatus,
  OrderActor,
  OrderKind,
  OrderPaymentStatus,
  OrderStatus,
  RefundStatus,
  SenderRole,
  Settlement,
} from '../../common/domain';
import { index, table } from '../database';
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
 */

type Timestamps = { createdAt: Date; updatedAt: Date };

const presentString = (field: string) => ({ partialFilterExpression: { [field]: { $type: 'string' } } });

/**
 * One seller's share of a checkout. The buyer's money sits with the payment
 * provider; the escrow fields record which way DOOAA has instructed it to go.
 */
export type OrderRow = Timestamps & {
  id: string;
  /** "482-301948271", also accepted in routes. The display number is "#" + this. */
  reference: string;
  checkoutId: string;
  buyerId: string;
  sellerId: string;
  kind: OrderKind;
  subtotal: number;
  discount: number;
  /** Percent, e.g. 7.5. */
  taxRate: number;
  tax: number;
  shipping: number;
  escrowFee: number;
  total: number;
  commission: number;
  /** What the seller is owed once escrow releases. */
  sellerEarning: number;
  currency: string;
  couponCode: string | null;
  delivery: DeliveryInfo;
  /* The order's copy of its charge. */
  paymentMethod: CheckoutMethod;
  paymentReference: string | null;
  paymentProvider: string | null;
  paymentStatus: OrderPaymentStatus;
  paymentPaidAt: Date | null;
  paymentBrand: string | null;
  paymentLast4: string | null;
  paymentChannel: string | null;
  status: OrderStatus;
  /* Escrow, from the moment the charge is confirmed. */
  /** "#3588-A3849-6788" — the console ledger's reference. */
  escrowReference: string | null;
  escrowPhase: EscrowPhase | null;
  escrowStatus: EscrowStatus | null;
  escrowSettlement: Settlement | null;
  escrowPhaseBeforeDispute: EscrowPhase | null;
  escrowFundedAt: Date | null;
  escrowShippedAt: Date | null;
  escrowReceivedAt: Date | null;
  escrowInspectionEndsAt: Date | null;
  escrowDisputedAt: Date | null;
  escrowReleasedAt: Date | null;
  escrowRefundedAt: Date | null;
  escrowSettledBy: string | null;
  escrowSettledAt: Date | null;
  escrowHistory: EscrowHistoryEntry[];
  /** The seller's dispatch deadline, counted from payment. */
  shipBy: Date | null;
  shipmentCarrier: string | null;
  shipmentTrackingNumber: string | null;
  shipmentProofUrl: string | null;
  shipmentNote: string | null;
  shippedAt: Date | null;
  confirmedAt: Date | null;
  deliveredAt: Date | null;
  /** End of the return window — "until Nov 2, 2025" on delivered orders. */
  returnBy: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  cancelledBy: OrderActor | null;
  /** The buyer asked to cancel after the seller confirmed. */
  cancellationRequestReason: string | null;
  cancellationRequestedAt: Date | null;
  /* The refund DOOAA asked the provider to make, if any. */
  refundStatus: RefundStatus | null;
  refundAmount: number | null;
  refundReference: string | null;
  refundRequestedAt: Date | null;
  refundProcessedAt: Date | null;
  refundFailureReason: string | null;
  timeline: TimelineEntry[];
  conversationId: string | null;
  offerId: string | null;
  disputeId: string | null;
  reviewId: string | null;
  /** When an unpaid order lapses. */
  expiresAt: Date | null;
};

export const orders = table<OrderRow>()('orders', {
  key: 'id',
  defaults: () => ({
    discount: 0,
    taxRate: 0,
    tax: 0,
    shipping: 0,
    escrowFee: 0,
    commission: 0,
    currency: 'NGN',
    paymentStatus: 'pending' as OrderPaymentStatus,
    status: 'awaiting-payment' as OrderStatus,
    escrowHistory: [] as EscrowHistoryEntry[],
    timeline: [] as TimelineEntry[],
  }),
  nullable: [
    'couponCode',
    'paymentReference',
    'paymentProvider',
    'paymentPaidAt',
    'paymentBrand',
    'paymentLast4',
    'paymentChannel',
    'escrowReference',
    'escrowPhase',
    'escrowStatus',
    'escrowSettlement',
    'escrowPhaseBeforeDispute',
    'escrowFundedAt',
    'escrowShippedAt',
    'escrowReceivedAt',
    'escrowInspectionEndsAt',
    'escrowDisputedAt',
    'escrowReleasedAt',
    'escrowRefundedAt',
    'escrowSettledBy',
    'escrowSettledAt',
    'shipBy',
    'shipmentCarrier',
    'shipmentTrackingNumber',
    'shipmentProofUrl',
    'shipmentNote',
    'shippedAt',
    'confirmedAt',
    'deliveredAt',
    'returnBy',
    'completedAt',
    'cancelledAt',
    'cancellationReason',
    'cancelledBy',
    'cancellationRequestReason',
    'cancellationRequestedAt',
    'refundStatus',
    'refundAmount',
    'refundReference',
    'refundRequestedAt',
    'refundProcessedAt',
    'refundFailureReason',
    'conversationId',
    'offerId',
    'disputeId',
    'reviewId',
    'expiresAt',
  ],
  indexes: [
    index('orders_reference_key', { reference: 1 }, { unique: true }),
    index('orders_escrow_reference_key', { escrowReference: 1 }, { unique: true, ...presentString('escrowReference') }),
    index('orders_buyer_idx', { buyerId: 1, createdAt: -1 }),
    index('orders_seller_idx', { sellerId: 1, createdAt: -1 }),
    index('orders_checkout_idx', { checkoutId: 1 }),
    index('orders_payment_reference_idx', { paymentReference: 1 }),
    index('orders_status_ship_by_idx', { status: 1, shipBy: 1 }),
    index('orders_escrow_status_idx', { escrowStatus: 1, escrowFundedAt: -1 }),
    index('orders_escrow_inspection_idx', { escrowPhase: 1, escrowInspectionEndsAt: 1 }),
    index('orders_expires_at_idx', { status: 1, expiresAt: 1 }),
  ],
});

/** An order line, frozen at the price and title it was bought at. */
export type OrderItemRow = {
  id: string;
  orderId: string;
  position: number;
  productId: string;
  title: string;
  sku: string;
  quantity: number;
  price: number;
  image: string;
  condition: Condition | null;
};

export const orderItems = table<OrderItemRow>()('order_items', {
  key: 'id',
  timestamps: false,
  defaults: () => ({ image: '' }),
  nullable: ['condition'],
  indexes: [
    index('order_items_order_position_key', { orderId: 1, position: 1 }, { unique: true }),
    index('order_items_product_idx', { productId: 1 }),
  ],
});

/** A buyer and a seller talking, usually about one listing and often one order. */
export type ConversationRow = Timestamps & {
  id: string;
  buyerId: string;
  sellerId: string;
  productId: string | null;
  subject: ConversationSubject | null;
  /** The escrow order this thread follows, once the buyer pays. */
  orderId: string | null;
  disputeId: string | null;
  lastMessagePreview: string;
  lastMessageKind: MessageKind | null;
  lastMessageAt: Date | null;
  /** A users.id or staff.id (staff speak in dispute threads). */
  lastMessageSenderId: string | null;
  buyerUnread: number;
  sellerUnread: number;
  buyerReadAt: Date | null;
  sellerReadAt: Date | null;
  /** When each side was last emailed about an unread message (jobs: reminders). */
  buyerRemindedAt?: Date | null;
  sellerRemindedAt?: Date | null;
};

export const conversations = table<ConversationRow>()('conversations', {
  key: 'id',
  defaults: () => ({ lastMessagePreview: '', buyerUnread: 0, sellerUnread: 0 }),
  nullable: ['productId', 'subject', 'orderId', 'disputeId', 'lastMessageKind', 'lastMessageAt', 'lastMessageSenderId', 'buyerReadAt', 'sellerReadAt', 'buyerRemindedAt', 'sellerRemindedAt'],
  indexes: [
    index('conversations_buyer_idx', { buyerId: 1, lastMessageAt: -1 }),
    index('conversations_seller_idx', { sellerId: 1, lastMessageAt: -1 }),
    index('conversations_thread_idx', { buyerId: 1, sellerId: 1, productId: 1, orderId: 1 }),
    index('conversations_order_idx', { orderId: 1 }),
  ],
});

export type MessageRow = Timestamps & {
  id: string;
  conversationId: string;
  /** A users.id or staff.id; null for platform system lines. */
  senderId: string | null;
  senderRole: SenderRole;
  kind: MessageKind;
  body: string;
  /** The highlighted lead-in on a system line ("Item marked as received."). */
  systemLead: string | null;
  media: MessageMedia | null;
  product: MessageProduct | null;
  offerId: string | null;
  meetup: MessageMeetup | null;
  dispute: MessageDispute | null;
};

export const messages = table<MessageRow>()('messages', {
  key: 'id',
  defaults: () => ({ body: '' }),
  nullable: ['senderId', 'systemLead', 'media', 'product', 'offerId', 'meetup', 'dispute'],
  indexes: [index('messages_conversation_idx', { conversationId: 1, createdAt: -1, _id: -1 })],
});

/**
 * A price negotiated in chat. An accepted offer (or an accepted counter)
 * becomes the price "Buy via Escrow" charges that buyer.
 */
export type OfferRow = Timestamps & {
  id: string;
  conversationId: string;
  productId: string;
  buyerId: string;
  sellerId: string;
  amount: number;
  /** The listing's asking price when the offer was made — "Product Price (Listed)". */
  listed: number;
  note: string;
  status: OfferStatus;
  counter: OfferCounter | null;
  /** The price both sides agreed, once accepted. */
  agreedAmount: number | null;
  respondedAt: Date | null;
  orderId: string | null;
};

export const offers = table<OfferRow>()('offers', {
  key: 'id',
  defaults: () => ({ note: '', status: 'pending' as OfferStatus }),
  nullable: ['counter', 'agreedAmount', 'respondedAt', 'orderId'],
  indexes: [
    index('offers_conversation_idx', { conversationId: 1, createdAt: -1 }),
    index('offers_buyer_product_idx', { buyerId: 1, productId: 1, status: 1 }),
  ],
});

export type DisputeRow = Timestamps & {
  id: string;
  /** "#3790". */
  reference: string;
  orderId: string;
  conversationId: string | null;
  buyerId: string;
  sellerId: string;
  item: string;
  orderValue: number;
  orderNumber: string;
  purchaseDate: Date;
  state: DisputeState;
  outcome: DisputeOutcome | null;
  openedBy: DisputeParty;
  /** The buyer's claim. */
  reason: string;
  sellerClaim: string | null;
  evidence: string[];
  sellerEvidence: string[];
  responseDueAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
};

export const disputes = table<DisputeRow>()('disputes', {
  key: 'id',
  defaults: () => ({ state: 'active' as DisputeState, openedBy: 'buyer' as DisputeParty, evidence: [] as string[], sellerEvidence: [] as string[] }),
  nullable: ['conversationId', 'outcome', 'sellerClaim', 'resolvedBy', 'resolvedAt', 'resolutionNote'],
  indexes: [
    index('disputes_reference_key', { reference: 1 }, { unique: true }),
    index('disputes_order_idx', { orderId: 1 }),
    index('disputes_state_idx', { state: 1, createdAt: -1 }),
    index('disputes_buyer_idx', { buyerId: 1, createdAt: -1 }),
    index('disputes_seller_idx', { sellerId: 1, createdAt: -1 }),
  ],
});

/**
 * "Rate your experience with …" — one per completed order, always a verified
 * purchase. The products it covers are the order's items.
 */
export type ReviewRow = Timestamps & {
  id: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  rating: number;
  aspects: ReviewAspects;
  body: string;
  response: ReviewResponse | null;
  /** Hidden by moderation; kept for the record but out of every average and list. */
  hidden: boolean;
};

export const reviews = table<ReviewRow>()('reviews', {
  key: 'id',
  defaults: () => ({ aspects: {} as ReviewAspects, body: '', hidden: false }),
  nullable: ['response'],
  indexes: [index('reviews_order_key', { orderId: 1 }, { unique: true }), index('reviews_seller_idx', { sellerId: 1, hidden: 1, createdAt: -1 })],
});
