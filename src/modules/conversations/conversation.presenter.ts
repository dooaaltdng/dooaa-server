import type { EscrowPhase } from '../../common/domain';
import { clockTime, dayKey, longDate, secondsUntil } from '../../common/util/dates';
import type { Lean } from '../../common/util/mongo';
import { maskLast4 } from '../../common/util/text';
import type { Order } from '../orders/schemas/order.schema';
import type { User } from '../users/schemas/user.schema';
import type { Conversation } from './schemas/conversation.schema';
import type { Message } from './schemas/message.schema';
import type { Offer } from './schemas/offer.schema';

/** The pill text the thread header shows for each escrow phase. */
export const ESCROW_LABEL: Record<EscrowPhase, string> = {
  funded: 'Funded',
  shipped: 'Item Is Shipped',
  inspection: 'Item Inspection',
  disputed: 'Item Disputed',
  released: 'Order Completed',
  refunded: 'Refunded',
};

export type MessageView = {
  id: string;
  conversationId: string;
  /** True when the viewer sent it. */
  mine: boolean;
  senderRole: Message['senderRole'];
  kind: Message['kind'];
  body: string;
  systemLead: string | null;
  media: { url: string; posterUrl: string | null; name: string | null; size: number | null; format: string | null } | null;
  product: { productId: string | null; title: string; price: number; image: string } | null;
  offerId: string | null;
  meetup: {
    venue: string;
    address: string;
    date: string;
    from: string;
    to: string;
    /** "Tue, Oct 27". */
    day: string;
    /** "2:00 PM - 4:00 PM". */
    window: string;
    photo: string | null;
    status: string;
  } | null;
  dispute: { by: string; reason: string } | null;
  createdAt: string;
  /** "04:15pm", in Lagos time. */
  time: string;
  /** Lagos calendar day, for the "Today" / "Yesterday" chips. */
  day: string;
};

export type OfferView = {
  id: string;
  amount: number;
  listed: number;
  note: string;
  status: Offer['status'];
  counter: { amount: number; note: string; at: string } | null;
  agreedAmount: number | null;
  from: { name: string; role: 'Buyer' };
  product: { id: string; title: string; summary: string; image: string };
  createdAt: string;
};

export type TrackingStep = { label: string; at: string | null; note: string; done: boolean };

export type ConversationEscrow = {
  orderId: string;
  orderNumber: string;
  phase: EscrowPhase;
  /** Funded / Item Is Shipped / Item Inspection / Item Disputed / Order Completed / Refunded. */
  status: string;
  trackHref: string;
  fundedOn: string;
  productPrice: number;
  fee: number;
  shipping: number;
  total: number;
  shipBy: string | null;
  inspectionEndsAt: string | null;
  shipWithinSeconds: number;
  inspectionSeconds: number;
  payment: { brand: string; ref: string };
  buyer: { name: string; mask: string };
  seller: { name: string; mask: string };
  trackingSteps: TrackingStep[];
  completed: {
    reference: string;
    completedOn: string;
    product: { title: string; seller: string; condition: string; purchasedOn: string; image: string };
    productPrice: number;
    platformFee: number;
    shippingFee: number;
    carrier: string;
    trackingNumber: string;
    deliverTo: { name: string; line1: string; line2: string; line3: string };
    sellerProfile: { name: string; memberSince: string };
    payment: { brand: string; last4: string; ref: string };
    history: { label: string; at: string }[];
  } | null;
};

export type ConversationSummary = {
  id: string;
  viewerRole: 'buyer' | 'seller';
  counterpart: { id: string; name: string; avatarUrl: string | null; storeName: string | null; verified: boolean; online: boolean };
  /** The counterpart's display name (the list's first line). */
  name: string;
  /** Store name under the name, or "Buyer" on the seller's side. */
  store: string | null;
  verified: boolean;
  productId: string | null;
  subject: { title: string; summary: string; image: string; price: number } | null;
  preview: string;
  lastMessageAt: string;
  unread: number;
  escrow: { orderId: string; phase: EscrowPhase; status: string } | null;
  offer: OfferView | null;
};

export type ConversationDetail = Omit<ConversationSummary, 'escrow'> & {
  escrow: ConversationEscrow | null;
  messages: MessageView[];
  hasMore: boolean;
};

function displayTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function meetupDay(date: string): string {
  return new Date(`${date}T12:00:00+01:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Africa/Lagos' });
}

export function toMessageView(message: Lean<Message>, viewerId: string): MessageView {
  return {
    id: String(message._id),
    conversationId: String(message.conversationId),
    mine: Boolean(message.senderId && String(message.senderId) === viewerId),
    senderRole: message.senderRole,
    kind: message.kind,
    body: message.body,
    systemLead: message.systemLead ?? null,
    media: message.media
      ? { url: message.media.url, posterUrl: message.media.posterUrl ?? null, name: message.media.name ?? null, size: message.media.size ?? null, format: message.media.format ?? null }
      : null,
    product: message.product ? { productId: message.product.productId ? String(message.product.productId) : null, title: message.product.title, price: message.product.price, image: message.product.image } : null,
    offerId: message.offerId ? String(message.offerId) : null,
    meetup: message.meetup
      ? {
          venue: message.meetup.venue,
          address: message.meetup.address || message.meetup.venue,
          date: message.meetup.date,
          from: message.meetup.from,
          to: message.meetup.to,
          day: meetupDay(message.meetup.date),
          window: `${displayTime(message.meetup.from)} - ${displayTime(message.meetup.to)}`,
          photo: message.meetup.photo ?? null,
          status: message.meetup.status,
        }
      : null,
    dispute: message.dispute ?? null,
    createdAt: new Date(message.createdAt).toISOString(),
    time: clockTime(message.createdAt),
    day: dayKey(message.createdAt),
  };
}

export function toOfferView(offer: Lean<Offer>, buyer: Lean<User> | null, subject: Conversation['subject'] | undefined): OfferView {
  return {
    id: String(offer._id),
    amount: offer.amount,
    listed: offer.listed,
    note: offer.note,
    status: offer.status,
    counter: offer.counter ? { amount: offer.counter.amount, note: offer.counter.note, at: new Date(offer.counter.at).toISOString() } : null,
    agreedAmount: offer.agreedAmount ?? null,
    from: { name: buyer ? `${buyer.firstName} ${buyer.lastName}` : 'Buyer', role: 'Buyer' },
    product: { id: String(offer.productId), title: subject?.title ?? '', summary: subject?.summary ?? '', image: subject?.image ?? '' },
    createdAt: new Date(offer.createdAt).toISOString(),
  };
}

export function trackingSteps(order: Lean<Order>): TrackingStep[] {
  const escrow = order.escrow;
  const iso = (value?: Date | null) => (value ? new Date(value).toISOString() : null);
  return [
    {
      label: 'Awaiting Shipped',
      at: iso(escrow?.shippedAt ?? escrow?.fundedAt),
      note: order.shipBy ? `Item should be shipped on or before ${longDate(order.shipBy)}.` : 'The seller is preparing the item.',
      done: Boolean(escrow?.shippedAt),
    },
    {
      label: 'In Transit',
      at: iso(escrow?.shippedAt),
      note: order.shipment ? `Handed to ${order.shipment.carrier}. Tracking number ${order.shipment.trackingNumber}.` : 'Out for delivery from the local distribution center.',
      done: Boolean(escrow?.shippedAt),
    },
    { label: 'Delivered', at: iso(escrow?.receivedAt), note: 'Your item has been delivered. The inspection has begun.', done: Boolean(escrow?.receivedAt) },
    {
      label: 'Inspection Period',
      at: iso(escrow?.inspectionEndsAt),
      note: "Buyer inspects the delivered item. If it's as described, funds will be released.",
      done: Boolean(escrow?.releasedAt),
    },
    { label: 'Order Confirm & Payment Released', at: iso(escrow?.releasedAt), note: 'Once you confirm delivery, funds will be released to the seller.', done: Boolean(escrow?.releasedAt) },
  ];
}

const CONDITION_LABEL: Record<string, string> = { new: 'Brand New', 'slightly-used': 'Slightly Used', used: 'Used', refurbished: 'Refurbished' };

export function toConversationEscrow(order: Lean<Order>, buyer: Lean<User> | null, seller: Lean<User> | null, sellerPayoutLast4?: string | null, now = new Date()): ConversationEscrow | null {
  if (!order.escrow) return null;
  const escrow = order.escrow;
  const sellerName = seller ? (seller.seller?.storeName || `${seller.firstName} ${seller.lastName}`) : 'Seller';
  const buyerName = buyer ? `${buyer.firstName} ${buyer.lastName}` : `${order.delivery.firstName} ${order.delivery.lastName}`;
  const item = order.items[0];
  return {
    orderId: order.reference,
    orderNumber: `#${order.reference}`,
    phase: escrow.phase,
    status: ESCROW_LABEL[escrow.phase],
    trackHref: `/orders/${order.reference}`,
    fundedOn: new Date(escrow.fundedAt).toISOString(),
    productPrice: Math.round((order.subtotal - order.discount) * 100) / 100,
    fee: order.escrowFee,
    shipping: order.shipping,
    total: order.total,
    shipBy: order.shipBy ? new Date(order.shipBy).toISOString() : null,
    inspectionEndsAt: escrow.inspectionEndsAt ? new Date(escrow.inspectionEndsAt).toISOString() : null,
    shipWithinSeconds: escrow.phase === 'funded' ? secondsUntil(order.shipBy, now) : 0,
    inspectionSeconds: escrow.phase === 'inspection' ? secondsUntil(escrow.inspectionEndsAt, now) : 0,
    payment: { brand: order.payment.brand ? `${order.payment.brand[0].toUpperCase()}${order.payment.brand.slice(1)}` : 'Card', ref: order.payment.reference ?? '' },
    buyer: { name: buyerName, mask: maskLast4(order.payment.last4) },
    seller: { name: sellerName, mask: maskLast4(sellerPayoutLast4) },
    trackingSteps: trackingSteps(order),
    completed:
      escrow.phase === 'released'
        ? {
            reference: `ORD-${order.reference}`,
            completedOn: new Date(order.completedAt ?? escrow.releasedAt ?? now).toISOString(),
            product: {
              title: item?.title ?? 'Order',
              seller: seller ? `${seller.firstName} ${seller.lastName}` : sellerName,
              condition: CONDITION_LABEL[item?.condition ?? ''] ?? 'Used',
              purchasedOn: new Date(escrow.fundedAt).toISOString(),
              image: item?.image ?? '',
            },
            productPrice: Math.round((order.subtotal - order.discount) * 100) / 100,
            platformFee: order.escrowFee,
            shippingFee: order.shipping,
            carrier: order.shipment?.carrier ?? 'Meetup handover',
            trackingNumber: order.shipment?.trackingNumber ?? '',
            deliverTo: {
              name: `${order.delivery.firstName} ${order.delivery.lastName}`,
              line1: order.delivery.address,
              line2: [order.delivery.city, order.delivery.zip].filter(Boolean).join(', '),
              line3: [order.delivery.state, 'Nigeria'].filter(Boolean).join(', '),
            },
            sellerProfile: { name: sellerName, memberSince: seller ? String(new Date(seller.createdAt).getUTCFullYear()) : '' },
            payment: { brand: order.payment.brand ?? 'Card', last4: order.payment.last4 ?? '', ref: order.payment.reference ?? '' },
            history: [
              escrow.shippedAt && { label: 'Awaiting Shipped', at: new Date(escrow.fundedAt).toISOString() },
              escrow.shippedAt && { label: 'In Transit', at: new Date(escrow.shippedAt).toISOString() },
              escrow.receivedAt && { label: 'Delivered', at: new Date(escrow.receivedAt).toISOString() },
              escrow.releasedAt && { label: 'Payment Released', at: new Date(escrow.releasedAt).toISOString() },
            ].filter((step): step is { label: string; at: string } => Boolean(step)),
          }
        : null,
  };
}
