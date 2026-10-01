import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/**
 * A seller's balances, in integer kobo. This is bookkeeping of funds the
 * payment provider holds on DOOAA's account for the seller — the money only
 * moves when the provider executes a transfer.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'wallets' })
export class Wallet {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  /** Released from escrow and not yet paid out. */
  @Prop({ default: 0 }) availableKobo: number;
  /** Still held in escrow on open orders. */
  @Prop({ default: 0 }) pendingKobo: number;
  /** Paid out to the seller's bank (transfers the provider confirmed). */
  @Prop({ default: 0 }) withdrawnKobo: number;
  createdAt: Date;
  updatedAt: Date;
}
export type WalletDocument = HydratedDocument<Wallet>;
export const WalletSchema = SchemaFactory.createForClass(Wallet);
WalletSchema.index({ sellerId: 1 }, { unique: true });

export const EARNING_STATUSES = ['pending', 'available', 'cancelled'] as const;
export type EarningStatus = (typeof EARNING_STATUSES)[number];

/** What one order owes its seller. One per order. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'earnings' })
export class Earning {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) orderId: Types.ObjectId;
  @Prop({ required: true }) orderNumber: string;
  @Prop({ required: true }) product: string;
  @Prop({ required: true }) amount: number;
  @Prop({ type: String, enum: EARNING_STATUSES, default: 'pending' }) status: EarningStatus;
  @Prop({ required: true }) fundedAt: Date;
  @Prop() releasedAt?: Date;
  @Prop() cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
export type EarningDocument = HydratedDocument<Earning>;
export const EarningSchema = SchemaFactory.createForClass(Earning);
EarningSchema.index({ orderId: 1 }, { unique: true });
EarningSchema.index({ sellerId: 1, status: 1, releasedAt: -1 });

export const PAYOUT_STATUSES = ['processing', 'completed', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

@Schema({ _id: false })
export class PayoutDestination {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) accountId: Types.ObjectId;
  @Prop({ required: true }) bankName: string;
  @Prop({ required: true }) accountName: string;
  @Prop({ required: true }) last4: string;
  @Prop({ required: true }) recipientCode: string;
}
const PayoutDestinationSchema = SchemaFactory.createForClass(PayoutDestination);

/** A withdrawal: one provider transfer to the seller's bank. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'payouts' })
export class Payout {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  /** Our transfer reference; the provider echoes it on webhooks. */
  @Prop({ required: true }) reference: string;
  @Prop({ required: true }) amount: number;
  @Prop({ type: PayoutDestinationSchema, required: true }) destination: PayoutDestination;
  @Prop({ type: String, enum: PAYOUT_STATUSES, default: 'processing' }) status: PayoutStatus;
  @Prop() transferCode?: string;
  @Prop() completedAt?: Date;
  @Prop() failedAt?: Date;
  @Prop() failureReason?: string;
  @Prop({ default: false }) automatic: boolean;
  @Prop({ default: 0 }) attempts: number;
  createdAt: Date;
  updatedAt: Date;
}
export type PayoutDocument = HydratedDocument<Payout>;
export const PayoutSchema = SchemaFactory.createForClass(Payout);
PayoutSchema.index({ reference: 1 }, { unique: true });
PayoutSchema.index({ sellerId: 1, createdAt: -1 });
PayoutSchema.index({ status: 1, createdAt: -1 });
