import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

/**
 * A bank account a seller is paid out to. The bank confirms the account name
 * through the provider and the provider registers it as a transfer
 * recipient; we keep only the last four digits and the recipient code.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'payout_accounts' })
export class PayoutAccount {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ required: true }) provider: string;
  @Prop({ required: true }) bankCode: string;
  @Prop({ required: true }) bankName: string;
  @Prop({ required: true }) accountName: string;
  @Prop({ required: true }) last4: string;
  /** sha256(bankCode:accountNumber), for de-duplication without storing the number. */
  @Prop({ required: true }) fingerprint: string;
  @Prop({ required: true }) recipientCode: string;
  @Prop({ default: true }) verified: boolean;
  @Prop({ default: false }) primary: boolean;
  @Prop({ type: String, enum: ['settings', 'verification'], default: 'settings' }) source: 'settings' | 'verification';
  createdAt: Date;
  updatedAt: Date;
}

export type PayoutAccountDocument = HydratedDocument<PayoutAccount>;
export const PayoutAccountSchema = SchemaFactory.createForClass(PayoutAccount);
PayoutAccountSchema.index({ userId: 1, fingerprint: 1 }, { unique: true });
