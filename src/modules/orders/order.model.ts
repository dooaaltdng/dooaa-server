import type {
  CheckoutMethod,
  Condition,
  EscrowPhase,
  EscrowStatus,
  OrderActor,
  OrderKind,
  OrderPaymentStatus,
  OrderStatus,
  RefundStatus,
  Settlement,
} from '../../common/domain';
import type { DeliveryInfo, EscrowHistoryEntry, TimelineEntry } from '../../database/schema';
import { orderItems, orders } from '../../database/schema';

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

export type OrderItem = {
  productId: string;
  title: string;
  sku: string;
  quantity: number;
  price: number;
  image: string;
  condition: Condition | null;
};

export type OrderPayment = {
  method: CheckoutMethod;
  reference: string | null;
  provider: string | null;
  status: OrderPaymentStatus;
  paidAt: Date | null;
  brand: string | null;
  last4: string | null;
  channel: string | null;
};

/**
 * Where the buyer's money stands. The funds themselves sit with the payment
 * provider; this records which way DOOAA has instructed them to go.
 */
export type OrderEscrow = {
  /** "#3588-A3849-6788" — the console ledger's reference. */
  reference: string;
  phase: EscrowPhase;
  status: EscrowStatus;
  settlement: Settlement | null;
  phaseBeforeDispute: EscrowPhase | null;
  fundedAt: Date;
  shippedAt: Date | null;
  receivedAt: Date | null;
  inspectionEndsAt: Date | null;
  disputedAt: Date | null;
  releasedAt: Date | null;
  refundedAt: Date | null;
  settledBy: string | null;
  settledAt: Date | null;
  history: EscrowHistoryEntry[];
};

export type OrderShipment = { carrier: string; trackingNumber: string; proofUrl: string | null; note: string | null; shippedAt: Date };

export type OrderRefund = {
  status: RefundStatus;
  amount: number;
  refundReference: string | null;
  requestedAt: Date;
  processedAt: Date | null;
  failureReason: string | null;
};

/** An order as the services and presenters see it: its row with the grouped parts and its items. */
export type Order = {
  id: string;
  /** "482-301948271", also accepted in routes. The display number is "#" + this. */
  reference: string;
  checkoutId: string;
  buyerId: string;
  sellerId: string;
  kind: OrderKind;
  items: OrderItem[];
  subtotal: number;
  discount: number;
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
  payment: OrderPayment;
  status: OrderStatus;
  escrow: OrderEscrow | null;
  /** The seller's dispatch deadline, counted from payment. */
  shipBy: Date | null;
  shipment: OrderShipment | null;
  confirmedAt: Date | null;
  deliveredAt: Date | null;
  /** End of the return window. */
  returnBy: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  cancelledBy: OrderActor | null;
  cancellationRequest: { reason: string; requestedAt: Date } | null;
  refund: OrderRefund | null;
  timeline: TimelineEntry[];
  conversationId: string | null;
  offerId: string | null;
  disputeId: string | null;
  reviewId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toOrderItem(row: OrderItemRow): OrderItem {
  return { productId: row.productId, title: row.title, sku: row.sku, quantity: row.quantity, price: row.price, image: row.image, condition: row.condition };
}

export function toOrder(row: OrderRow, items: OrderItemRow[]): Order {
  return {
    id: row.id,
    reference: row.reference,
    checkoutId: row.checkoutId,
    buyerId: row.buyerId,
    sellerId: row.sellerId,
    kind: row.kind,
    items: [...items].sort((a, b) => a.position - b.position).map(toOrderItem),
    subtotal: row.subtotal,
    discount: row.discount,
    taxRate: row.taxRate,
    tax: row.tax,
    shipping: row.shipping,
    escrowFee: row.escrowFee,
    total: row.total,
    commission: row.commission,
    sellerEarning: row.sellerEarning,
    currency: row.currency,
    couponCode: row.couponCode,
    delivery: row.delivery,
    payment: {
      method: row.paymentMethod,
      reference: row.paymentReference,
      provider: row.paymentProvider,
      status: row.paymentStatus,
      paidAt: row.paymentPaidAt,
      brand: row.paymentBrand,
      last4: row.paymentLast4,
      channel: row.paymentChannel,
    },
    status: row.status,
    escrow:
      row.escrowReference && row.escrowPhase && row.escrowStatus && row.escrowFundedAt
        ? {
            reference: row.escrowReference,
            phase: row.escrowPhase,
            status: row.escrowStatus,
            settlement: row.escrowSettlement,
            phaseBeforeDispute: row.escrowPhaseBeforeDispute,
            fundedAt: row.escrowFundedAt,
            shippedAt: row.escrowShippedAt,
            receivedAt: row.escrowReceivedAt,
            inspectionEndsAt: row.escrowInspectionEndsAt,
            disputedAt: row.escrowDisputedAt,
            releasedAt: row.escrowReleasedAt,
            refundedAt: row.escrowRefundedAt,
            settledBy: row.escrowSettledBy,
            settledAt: row.escrowSettledAt,
            history: row.escrowHistory,
          }
        : null,
    shipBy: row.shipBy,
    shipment:
      row.shipmentCarrier && row.shippedAt
        ? { carrier: row.shipmentCarrier, trackingNumber: row.shipmentTrackingNumber ?? '', proofUrl: row.shipmentProofUrl, note: row.shipmentNote, shippedAt: row.shippedAt }
        : null,
    confirmedAt: row.confirmedAt,
    deliveredAt: row.deliveredAt,
    returnBy: row.returnBy,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    cancelledBy: row.cancelledBy,
    cancellationRequest:
      row.cancellationRequestReason && row.cancellationRequestedAt ? { reason: row.cancellationRequestReason, requestedAt: row.cancellationRequestedAt } : null,
    refund:
      row.refundStatus && row.refundAmount !== null && row.refundRequestedAt
        ? {
            status: row.refundStatus,
            amount: row.refundAmount,
            refundReference: row.refundReference,
            requestedAt: row.refundRequestedAt,
            processedAt: row.refundProcessedAt,
            failureReason: row.refundFailureReason,
          }
        : null,
    timeline: row.timeline,
    conversationId: row.conversationId,
    offerId: row.offerId,
    disputeId: row.disputeId,
    reviewId: row.reviewId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
