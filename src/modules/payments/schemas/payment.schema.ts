import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { CHECKOUT_METHODS, type CheckoutMethod } from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'abandoned'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = ['pending', 'processed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

@Schema({ _id: false })
export class PaymentCard {
  @Prop() last4?: string;
  @Prop() brand?: string;
  @Prop() bank?: string;
  @Prop() expMonth?: string;
  @Prop() expYear?: string;
}
const PaymentCardSchema = SchemaFactory.createForClass(PaymentCard);

/** One refund the provider was asked to make against this charge. */
@Schema({ _id: false })
export class PaymentRefund {
  @Prop({ required: true }) refundReference: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) orderId?: Types.ObjectId;
  @Prop({ required: true }) amount: number;
  @Prop() providerRefundId?: string;
  @Prop({ type: String, enum: REFUND_STATUSES, default: 'pending' }) status: RefundStatus;
  @Prop() reason?: string;
  @Prop({ required: true }) requestedAt: Date;
  @Prop() processedAt?: Date;
  @Prop() failureReason?: string;
}
const PaymentRefundSchema = SchemaFactory.createForClass(PaymentRefund);

/**
 * Our record of one charge the provider made. The provider is the source of
 * truth; this mirrors what it confirmed (via verify or a signed webhook).
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'payments' })
export class Payment {
  @Prop({ required: true }) reference: string;
  @Prop({ required: true }) provider: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) buyerId: Types.ObjectId;
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] }) orderIds: Types.ObjectId[];
  @Prop({ required: true }) checkoutId: string;
  @Prop({ required: true }) amount: number;
  @Prop({ default: 'NGN' }) currency: string;
  @Prop({ type: String, enum: CHECKOUT_METHODS, required: true }) method: CheckoutMethod;
  @Prop({ type: String, enum: PAYMENT_STATUSES, default: 'pending' }) status: PaymentStatus;
  @Prop() authorizationUrl?: string;
  @Prop() accessCode?: string;
  @Prop() paidAt?: Date;
  /** Set once the orders this charge paid for have been fulfilled (escrow funded, sellers told). */
  @Prop() fulfilledAt?: Date;
  /** Claimed by the one caller fulfilling the charge (webhook and verify can race). */
  @Prop() fulfillingAt?: Date;
  @Prop() channel?: string;
  @Prop() gatewayResponse?: string;
  @Prop() providerTransactionId?: string;
  @Prop() failureReason?: string;
  /** Paid amount the provider reported, when it disagreed with ours. */
  @Prop() reportedAmount?: number;
  @Prop({ type: PaymentCardSchema }) card?: PaymentCard;
  @Prop({ type: [PaymentRefundSchema], default: [] }) refunds: PaymentRefund[];
  @Prop({ type: [{ type: String }], default: [] }) events: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ reference: 1 }, { unique: true });
PaymentSchema.index({ buyerId: 1, createdAt: -1 });
PaymentSchema.index({ checkoutId: 1 });
PaymentSchema.index({ status: 1, createdAt: 1 });
PaymentSchema.index({ status: 1, fulfilledAt: 1 });
PaymentSchema.index({ 'refunds.providerRefundId': 1 });
PaymentSchema.index({ 'refunds.refundReference': 1 });
