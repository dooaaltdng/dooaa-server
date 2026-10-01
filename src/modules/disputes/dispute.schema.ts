import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { DISPUTE_OUTCOMES, DISPUTE_STATES, type DisputeOutcome, type DisputeState } from '../../common/domain';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

@Schema({ ...SCHEMA_OPTIONS, collection: 'disputes' })
export class Dispute {
  /** "#3790". */
  @Prop({ required: true }) reference: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) orderId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) conversationId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) buyerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ required: true }) item: string;
  @Prop({ required: true }) orderValue: number;
  @Prop({ required: true }) orderNumber: string;
  @Prop({ required: true }) purchaseDate: Date;
  @Prop({ type: String, enum: DISPUTE_STATES, default: 'active' }) state: DisputeState;
  @Prop({ type: String, enum: [...DISPUTE_OUTCOMES, null], default: null }) outcome: DisputeOutcome | null;
  @Prop({ type: String, enum: ['buyer', 'seller'], default: 'buyer' }) openedBy: 'buyer' | 'seller';
  /** The buyer's claim. */
  @Prop({ required: true }) reason: string;
  @Prop() sellerClaim?: string;
  @Prop({ type: [String], default: [] }) evidence: string[];
  @Prop({ type: [String], default: [] }) sellerEvidence: string[];
  @Prop({ required: true }) responseDueAt: Date;
  @Prop() resolvedBy?: string;
  @Prop() resolvedAt?: Date;
  @Prop() resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DisputeDocument = HydratedDocument<Dispute>;
export const DisputeSchema = SchemaFactory.createForClass(Dispute);
DisputeSchema.index({ reference: 1 }, { unique: true });
DisputeSchema.index({ orderId: 1 });
DisputeSchema.index({ state: 1, createdAt: -1 });
DisputeSchema.index({ buyerId: 1, createdAt: -1 });
DisputeSchema.index({ sellerId: 1, createdAt: -1 });
