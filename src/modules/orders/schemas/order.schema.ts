import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import {
  CHECKOUT_METHODS,
  CONDITIONS,
  ESCROW_PHASES,
  ESCROW_STATUSES,
  ORDER_KINDS,
  ORDER_STATUSES,
  SETTLEMENTS,
  type CheckoutMethod,
  type Condition,
  type EscrowPhase,
  type EscrowStatus,
  type OrderKind,
  type OrderStatus,
  type Settlement,
} from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';
import { DeliveryInfo, DeliveryInfoSchema } from '../../cart/cart.schema';

@Schema({ _id: false })
export class OrderItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) productId: Types.ObjectId;
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) sku: string;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ required: true }) price: number;
  @Prop({ default: '' }) image: string;
  @Prop({ type: String, enum: CONDITIONS }) condition?: Condition;
}
const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class OrderPayment {
  @Prop({ type: String, enum: CHECKOUT_METHODS, required: true }) method: CheckoutMethod;
  @Prop() reference?: string;
  @Prop() provider?: string;
  @Prop({ type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' }) status: 'pending' | 'paid' | 'failed';
  @Prop() paidAt?: Date;
  @Prop() brand?: string;
  @Prop() last4?: string;
  @Prop() channel?: string;
}
const OrderPaymentSchema = SchemaFactory.createForClass(OrderPayment);

@Schema({ _id: false })
export class OrderShipment {
  @Prop({ required: true }) carrier: string;
  @Prop({ default: '' }) trackingNumber: string;
  @Prop() proofUrl?: string;
  @Prop() note?: string;
  @Prop({ required: true }) shippedAt: Date;
}
const OrderShipmentSchema = SchemaFactory.createForClass(OrderShipment);

@Schema({ _id: false })
export class OrderRefund {
  @Prop({ type: String, enum: ['pending', 'processed', 'failed'], required: true }) status: 'pending' | 'processed' | 'failed';
  @Prop({ required: true }) amount: number;
  @Prop() refundReference?: string;
  @Prop({ required: true }) requestedAt: Date;
  @Prop() processedAt?: Date;
  @Prop() failureReason?: string;
}
const OrderRefundSchema = SchemaFactory.createForClass(OrderRefund);

@Schema({ _id: false })
export class EscrowHistoryEntry {
  @Prop({ required: true }) action: string;
  @Prop({ required: true }) by: string;
  @Prop({ required: true }) at: Date;
  @Prop() note?: string;
}
const EscrowHistoryEntrySchema = SchemaFactory.createForClass(EscrowHistoryEntry);

/**
 * Where the buyer's money stands. The funds themselves sit with the payment
 * provider; this records which way DOOAA has instructed them to go.
 */
@Schema({ _id: false })
export class OrderEscrow {
  /** "#3588-A3849-6788" — the console ledger's reference. */
  @Prop({ required: true }) reference: string;
  @Prop({ type: String, enum: ESCROW_PHASES, required: true }) phase: EscrowPhase;
  @Prop({ type: String, enum: ESCROW_STATUSES, required: true }) status: EscrowStatus;
  @Prop({ type: String, enum: [...SETTLEMENTS, null], default: null }) settlement: Settlement | null;
  @Prop({ type: String, enum: [...ESCROW_PHASES, null], default: null }) phaseBeforeDispute: EscrowPhase | null;
  @Prop({ required: true }) fundedAt: Date;
  @Prop() shippedAt?: Date;
  @Prop() receivedAt?: Date;
  @Prop() inspectionEndsAt?: Date;
  @Prop() disputedAt?: Date;
  @Prop() releasedAt?: Date;
  @Prop() refundedAt?: Date;
  @Prop() settledBy?: string;
  @Prop() settledAt?: Date;
  @Prop({ type: [EscrowHistoryEntrySchema], default: [] }) history: EscrowHistoryEntry[];
}
const OrderEscrowSchema = SchemaFactory.createForClass(OrderEscrow);

@Schema({ _id: false })
export class TimelineEntry {
  /** placed, confirmed, shipped, delivered, released, cancelled, refunded, disputed, dispute-resolved, reversed… */
  @Prop({ required: true }) code: string;
  @Prop({ required: true }) label: string;
  @Prop({ default: '' }) description: string;
  @Prop({ required: true }) at: Date;
}
const TimelineEntrySchema = SchemaFactory.createForClass(TimelineEntry);

@Schema({ _id: false })
export class CancellationRequest {
  @Prop({ required: true }) reason: string;
  @Prop({ required: true }) requestedAt: Date;
}
const CancellationRequestSchema = SchemaFactory.createForClass(CancellationRequest);

@Schema({ ...SCHEMA_OPTIONS, collection: 'orders' })
export class Order {
  /** "482-301948271", also accepted in routes. The display number is "#" + this. */
  @Prop({ required: true }) reference: string;
  @Prop({ required: true }) checkoutId: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) buyerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ type: String, enum: ORDER_KINDS, required: true }) kind: OrderKind;
  @Prop({ type: [OrderItemSchema], required: true }) items: OrderItem[];

  @Prop({ required: true }) subtotal: number;
  @Prop({ default: 0 }) discount: number;
  @Prop({ default: 0 }) taxRate: number;
  @Prop({ default: 0 }) tax: number;
  @Prop({ default: 0 }) shipping: number;
  @Prop({ default: 0 }) escrowFee: number;
  @Prop({ required: true }) total: number;
  @Prop({ default: 0 }) commission: number;
  /** What the seller is owed once escrow releases. */
  @Prop({ required: true }) sellerEarning: number;
  @Prop({ default: 'NGN' }) currency: string;
  @Prop() couponCode?: string;

  @Prop({ type: DeliveryInfoSchema, required: true }) delivery: DeliveryInfo;
  @Prop({ type: OrderPaymentSchema, required: true }) payment: OrderPayment;
  @Prop({ type: String, enum: ORDER_STATUSES, default: 'awaiting-payment' }) status: OrderStatus;
  @Prop({ type: OrderEscrowSchema }) escrow?: OrderEscrow;

  /** The seller's dispatch deadline, counted from payment. */
  @Prop() shipBy?: Date;
  @Prop({ type: OrderShipmentSchema }) shipment?: OrderShipment;
  @Prop() confirmedAt?: Date;
  @Prop() deliveredAt?: Date;
  /** End of the return window — "until Nov 2, 2025" on delivered orders. */
  @Prop() returnBy?: Date;
  @Prop() completedAt?: Date;
  @Prop() cancelledAt?: Date;
  @Prop() cancellationReason?: string;
  @Prop({ type: String, enum: ['buyer', 'seller', 'system', 'staff'] }) cancelledBy?: 'buyer' | 'seller' | 'system' | 'staff';
  @Prop({ type: CancellationRequestSchema }) cancellationRequest?: CancellationRequest;
  @Prop({ type: OrderRefundSchema }) refund?: OrderRefund;

  @Prop({ type: [TimelineEntrySchema], default: [] }) timeline: TimelineEntry[];
  @Prop({ type: MongooseSchema.Types.ObjectId }) conversationId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) offerId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) disputeId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) reviewId?: Types.ObjectId;
  @Prop() expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderDocument = HydratedDocument<Order>;
export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.index({ reference: 1 }, { unique: true });
OrderSchema.index({ buyerId: 1, createdAt: -1 });
OrderSchema.index({ sellerId: 1, createdAt: -1 });
OrderSchema.index({ checkoutId: 1 });
OrderSchema.index({ 'payment.reference': 1 });
OrderSchema.index({ status: 1, shipBy: 1 });
OrderSchema.index({ 'escrow.reference': 1 }, { unique: true, partialFilterExpression: { 'escrow.reference': { $type: 'string' } } });
OrderSchema.index({ 'escrow.status': 1, 'escrow.fundedAt': -1 });
OrderSchema.index({ 'escrow.phase': 1, 'escrow.inspectionEndsAt': 1 });
