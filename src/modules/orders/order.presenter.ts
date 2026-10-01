import { escrowStatusOf, type EscrowPhase, type OrderKind, type OrderStatus, type Settlement } from '../../common/domain';
import { addDays, clockTimeUpper, longDate, ordinalDate, secondsUntil } from '../../common/util/dates';
import type { Lean } from '../../common/util/mongo';
import { maskLast4 } from '../../common/util/text';
import type { User } from '../users/schemas/user.schema';
import { buyerActions, escrowStateLabel, sellerActions, type BuyerAction, type SellerAction } from './order-state';
import type { Order } from './schemas/order.schema';

export type TrackingEvent = {
  label: string;
  description: string;
  /** Absent while the step is still projected (the top step). */
  at?: string;
  /** "Estimated delivery: Oct 28, 2025". */
  estimate?: string;
};

export type EscrowSummary = {
  reference: string;
  phase: EscrowPhase;
  /** Held / Released / Refunded, as the seller's Escrow Payments tab groups them. */
  state: 'held' | 'released' | 'refunded' | 'unpaid';
  settlement: Settlement | null;
  fundedAt: string;
  shipBy: string | null;
  inspectionEndsAt: string | null;
  /** Live countdowns, computed when the response was built. */
  shipWithinSeconds: number;
  inspectionSeconds: number;
};

export type OrderView = {
  id: string;
  orderId: string;
  number: string;
  checkoutId: string;
  placedAt: string;
  status: OrderStatus;
  kind: OrderKind;
  items: { id: string; productId: string; name: string; sku: string; quantity: number; price: number; image: string; condition?: string }[];
  subtotal: number;
  discount: number;
  taxRate: number;
  tax: number;
  shipping: number;
  escrowFee: number;
  total: number;
  couponCode: string | null;
  address: { name: string; line1: string; line2: string; phone: string; email: string };
  payment: { method: string; brand: string | null; last4: string | null; reference: string | null; status: string; paidAt: string | null };
  tracking: { number: string | null; carrier: string | null; events: TrackingEvent[] } | null;
  shipment: { carrier: string; trackingNumber: string; proofUrl: string | null; shippedAt: string } | null;
  escrow: EscrowSummary | null;
  deliveredAt: string | null;
  returnBy: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancelledBy: string | null;
  cancellationRequested: boolean;
  refunded: boolean;
  refundStatus: 'pending' | 'processed' | 'failed' | null;
  conversationId: string | null;
  disputeId: string | null;
  reviewed: boolean;
  seller: { id: string; name: string; storeName: string | null } | null;
};

export type BuyerOrderView = OrderView & { actions: BuyerAction[] };
export type SellerOrderView = OrderView & {
  customer: { id: string; name: string; email: string; phone: string };
  /** "One time" or "Escrow payment" in the Type column. */
  kindLabel: 'One time' | 'Escrow payment';
  sellerEarning: number;
  commission: number;
  actions: SellerAction[];
};

const PROJECTED: Partial<Record<OrderStatus, { buyer: Omit<TrackingEvent, 'at'>; seller: Omit<TrackingEvent, 'at'> }>> = {
  pending: {
    buyer: { label: 'Awaiting seller confirmation', description: 'We have notified the seller. Your payment is held in escrow.', estimate: 'Usually confirmed within 24 hours' },
    seller: { label: 'Awaiting your confirmation', description: "The buyer's payment is held in escrow until you confirm.", estimate: 'Confirm within 24 hours' },
  },
};

function projected(order: Lean<Order>, side: 'buyer' | 'seller', deliveryEstimateDays: number): TrackingEvent | null {
  switch (order.status) {
    case 'pending':
      return PROJECTED.pending![side];
    case 'confirmed':
      return side === 'buyer'
        ? { label: 'Preparing for dispatch', description: 'The seller is packing your order.', estimate: order.shipBy ? `Ships by ${longDate(order.shipBy)}` : undefined }
        : { label: 'Preparing for dispatch', description: 'Pack the order and hand it to your carrier.', estimate: order.shipBy ? `Ship by ${longDate(order.shipBy)}` : undefined };
    case 'shipped': {
      const from = order.shipment?.shippedAt ?? new Date();
      return { label: 'In transit', description: 'The package is on its way.', estimate: `Estimated delivery: ${longDate(addDays(new Date(from), deliveryEstimateDays))}` };
    }
    case 'delivered':
      if (order.escrow?.phase === 'inspection' && order.escrow.inspectionEndsAt) {
        return {
          label: 'Inspection period',
          description: side === 'buyer' ? 'Check the item. Funds release to the seller when you confirm or when the window closes.' : 'The buyer is inspecting the item. Funds release when they confirm or the window closes.',
          estimate: `Releases ${longDate(order.escrow.inspectionEndsAt)}`,
        };
      }
      return null;
    default:
      return null;
  }
}

/** Newest first, with the projected next step on top — the tracking panel's order. */
export function trackingEvents(order: Lean<Order>, side: 'buyer' | 'seller', deliveryEstimateDays = 3): TrackingEvent[] {
  const actual = [...order.timeline]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map((entry) => ({ label: entry.label, description: entry.description, at: new Date(entry.at).toISOString() }));
  const next = projected(order, side, deliveryEstimateDays);
  return next ? [next, ...actual] : actual;
}

export function escrowSummary(order: Lean<Order>, now = new Date()): EscrowSummary | null {
  if (!order.escrow) return null;
  return {
    reference: order.escrow.reference,
    phase: order.escrow.phase,
    state: escrowStateLabel(order.escrow.phase),
    settlement: order.escrow.settlement ?? null,
    fundedAt: new Date(order.escrow.fundedAt).toISOString(),
    shipBy: order.shipBy ? new Date(order.shipBy).toISOString() : null,
    inspectionEndsAt: order.escrow.inspectionEndsAt ? new Date(order.escrow.inspectionEndsAt).toISOString() : null,
    shipWithinSeconds: order.status === 'pending' || order.status === 'confirmed' ? secondsUntil(order.shipBy, now) : 0,
    inspectionSeconds: order.escrow.phase === 'inspection' ? secondsUntil(order.escrow.inspectionEndsAt, now) : 0,
  };
}

function iso(value?: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function toOrderView(order: Lean<Order>, seller: Lean<User> | null, side: 'buyer' | 'seller', deliveryEstimateDays = 3): OrderView {
  const id = String(order._id);
  const delivery = order.delivery;
  return {
    id: order.reference,
    orderId: id,
    number: `#${order.reference}`,
    checkoutId: order.checkoutId,
    placedAt: new Date(order.createdAt).toISOString(),
    status: order.status,
    kind: order.kind,
    items: order.items.map((item, index) => ({
      id: `${String(item.productId)}-${index}`,
      productId: String(item.productId),
      name: item.title,
      sku: item.sku,
      quantity: item.quantity,
      price: item.price,
      image: item.image,
      condition: item.condition,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    taxRate: order.taxRate,
    tax: order.tax,
    shipping: order.shipping,
    escrowFee: order.escrowFee,
    total: order.total,
    couponCode: order.couponCode ?? null,
    address: {
      name: `${delivery.firstName} ${delivery.lastName}`.trim(),
      line1: delivery.address,
      line2: [delivery.city, delivery.state, delivery.zip].filter(Boolean).join(', '),
      phone: delivery.phone,
      email: delivery.email,
    },
    payment: {
      method: order.payment.method,
      brand: order.payment.brand ?? null,
      last4: order.payment.last4 ?? null,
      reference: order.payment.reference ?? null,
      status: order.payment.status,
      paidAt: iso(order.payment.paidAt),
    },
    tracking:
      order.status === 'awaiting-payment'
        ? null
        : { number: order.shipment?.trackingNumber || null, carrier: order.shipment?.carrier ?? null, events: trackingEvents(order, side, deliveryEstimateDays) },
    shipment: order.shipment
      ? { carrier: order.shipment.carrier, trackingNumber: order.shipment.trackingNumber, proofUrl: order.shipment.proofUrl ?? null, shippedAt: new Date(order.shipment.shippedAt).toISOString() }
      : null,
    escrow: escrowSummary(order),
    deliveredAt: iso(order.deliveredAt),
    returnBy: iso(order.returnBy),
    completedAt: iso(order.completedAt),
    cancelledAt: iso(order.cancelledAt),
    cancellationReason: order.cancellationReason ?? null,
    cancelledBy: order.cancelledBy ?? null,
    cancellationRequested: Boolean(order.cancellationRequest),
    refunded: order.refund?.status === 'processed',
    refundStatus: order.refund?.status ?? null,
    conversationId: order.conversationId ? String(order.conversationId) : null,
    disputeId: order.disputeId ? String(order.disputeId) : null,
    reviewed: Boolean(order.reviewId),
    seller: seller ? { id: String(seller._id), name: `${seller.firstName} ${seller.lastName}`.trim(), storeName: seller.seller?.storeName ?? null } : null,
  };
}

export function orderState(order: Lean<Order>) {
  return {
    status: order.status,
    escrowPhase: order.escrow?.phase ?? null,
    shipBy: order.shipBy ?? null,
    cancellationRequested: Boolean(order.cancellationRequest),
    disputed: Boolean(order.disputeId) && order.escrow?.phase === 'disputed',
    reviewed: Boolean(order.reviewId),
  };
}

export function toBuyerOrderView(order: Lean<Order>, seller: Lean<User> | null, deliveryEstimateDays = 3, now = new Date()): BuyerOrderView {
  return { ...toOrderView(order, seller, 'buyer', deliveryEstimateDays), actions: buyerActions(orderState(order), now) };
}

export function toSellerOrderView(order: Lean<Order>, buyer: Lean<User> | null, seller: Lean<User> | null, deliveryEstimateDays = 3): SellerOrderView {
  return {
    ...toOrderView(order, seller, 'seller', deliveryEstimateDays),
    customer: {
      id: String(order.buyerId),
      name: buyer ? `${buyer.firstName} ${buyer.lastName}`.trim() : `${order.delivery.firstName} ${order.delivery.lastName}`.trim(),
      email: buyer?.email ?? order.delivery.email,
      phone: buyer?.phone || order.delivery.phone,
    },
    kindLabel: order.kind === 'escrow' ? 'Escrow payment' : 'One time',
    sellerEarning: order.sellerEarning,
    commission: order.commission,
    actions: sellerActions(orderState(order)),
  };
}

/* --- The console's escrow ledger ------------------------------------------------ */

export type TimelineStage = 'secured' | 'shipped' | 'received' | 'released';
export type TimelineStep = { stage: TimelineStage; state: 'done' | 'pending' | 'blocked'; date?: string; time?: string; note?: string };

export type EscrowTransactionView = {
  id: string;
  orderId: string;
  orderNumber: string;
  reference: string;
  status: 'pending' | 'completed' | 'dispute';
  phase: EscrowPhase;
  settlement: Settlement | null;
  buyerId: string;
  buyerName: string;
  buyerEmail: string;
  buyerAvatar: string | null;
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  sellerAvatar: string | null;
  listingId: string;
  item: string;
  /** The first item's photo, as it was at checkout. */
  image: string | null;
  productRef: string;
  category: string | null;
  productPrice: number;
  deliveryFee: number;
  escrowFee: number;
  tax: number;
  amount: number;
  sellerEarning: number;
  paymentMethod: string;
  paymentReference: string;
  initiatedOn: string;
  timeline: TimelineStep[];
  history: { action: string; by: string; at: string; note?: string }[];
  disputeId: string | null;
};

const METHOD_LABEL: Record<string, string> = { card: 'Credit Card', transfer: 'Bank Transfer', ussd: 'USSD', bank: 'Bank' };

function done(stage: TimelineStage, at: Date): TimelineStep {
  return { stage, state: 'done', date: ordinalDate(at), time: clockTimeUpper(at) };
}

export function escrowTimeline(order: Lean<Order>): TimelineStep[] {
  const escrow = order.escrow!;
  const secured = done('secured', escrow.fundedAt);
  // A release confirms the item reached the buyer, even when it was handed over without a courier.
  const handedOver = escrow.shippedAt ?? (escrow.releasedAt ? (escrow.receivedAt ?? escrow.releasedAt) : undefined);
  const shipped = handedOver ? done('shipped', handedOver) : ({ stage: 'shipped', state: escrow.phase === 'refunded' ? 'blocked' : 'pending', ...(escrow.phase === 'refunded' ? { note: 'Refunded before dispatch' } : {}) } as TimelineStep);
  if (escrow.phase === 'disputed') {
    return [
      secured,
      shipped,
      escrow.receivedAt ? done('received', escrow.receivedAt) : { stage: 'received', state: 'blocked', note: 'Disputed by the buyer' },
      { stage: 'released', state: 'blocked', note: 'On hold pending moderation' },
    ];
  }
  if (escrow.phase === 'refunded') {
    return [
      secured,
      shipped,
      escrow.receivedAt ? done('received', escrow.receivedAt) : { stage: 'received', state: 'blocked', note: 'Refunded to the buyer' },
      { stage: 'released', state: 'blocked', note: 'Refunded to the buyer' },
    ];
  }
  return [
    secured,
    shipped,
    escrow.receivedAt ? done('received', escrow.receivedAt) : { stage: 'received', state: 'pending' },
    escrow.releasedAt ? done('released', escrow.releasedAt) : { stage: 'released', state: 'pending' },
  ];
}

export function toEscrowTransaction(order: Lean<Order>, buyer: Lean<User> | null, seller: Lean<User> | null, categoryId: string | null): EscrowTransactionView {
  const escrow = order.escrow!;
  const first = order.items[0];
  return {
    id: String(order._id),
    orderId: String(order._id),
    orderNumber: `#${order.reference}`,
    reference: escrow.reference,
    status: escrowStatusOf(escrow.phase),
    phase: escrow.phase,
    settlement: escrow.settlement ?? null,
    buyerId: String(order.buyerId),
    buyerName: buyer ? `${buyer.firstName} ${buyer.lastName}` : `${order.delivery.firstName} ${order.delivery.lastName}`,
    buyerEmail: buyer?.email ?? order.delivery.email,
    buyerAvatar: buyer?.avatarUrl ?? null,
    sellerId: String(order.sellerId),
    sellerName: seller ? (seller.seller?.storeName ? seller.seller.storeName : `${seller.firstName} ${seller.lastName}`) : 'Seller',
    sellerEmail: seller?.email ?? '',
    sellerAvatar: seller?.avatarUrl ?? null,
    listingId: String(first?.productId ?? ''),
    item: order.items.length > 1 ? `${first.title} +${order.items.length - 1} more` : (first?.title ?? 'Order'),
    image: first?.image || null,
    productRef: `#PROD-${String(first?.productId ?? '').slice(-6).toUpperCase()}`,
    category: categoryId,
    productPrice: Math.round((order.subtotal - order.discount) * 100) / 100,
    deliveryFee: order.shipping,
    escrowFee: order.escrowFee,
    tax: order.tax,
    amount: order.total,
    sellerEarning: order.sellerEarning,
    paymentMethod: METHOD_LABEL[order.payment.method] ?? order.payment.method,
    paymentReference: order.payment.reference ?? '',
    initiatedOn: new Date(escrow.fundedAt).toISOString(),
    timeline: escrowTimeline(order),
    history: escrow.history.map((entry) => ({ action: entry.action, by: entry.by, at: new Date(entry.at).toISOString(), ...(entry.note ? { note: entry.note } : {}) })),
    disputeId: order.disputeId ? String(order.disputeId) : null,
  };
}

export function paymentMask(order: Lean<Order>): string {
  return maskLast4(order.payment.last4);
}
