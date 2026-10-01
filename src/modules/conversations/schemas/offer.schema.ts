import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { OFFER_STATUSES, type OfferStatus } from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

@Schema({ _id: false })
export class OfferCounter {
  @Prop({ required: true }) amount: number;
  @Prop({ default: '' }) note: string;
  @Prop({ required: true }) at: Date;
}
const OfferCounterSchema = SchemaFactory.createForClass(OfferCounter);

/**
 * A price negotiated in chat. An accepted offer (or an accepted counter)
 * becomes the price "Buy via Escrow" charges for that buyer.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'offers' })
export class Offer {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) conversationId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) productId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) buyerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ required: true }) amount: number;
  /** The listing's asking price when the offer was made — "Product Price (Listed)". */
  @Prop({ required: true }) listed: number;
  @Prop({ default: '' }) note: string;
  @Prop({ type: String, enum: OFFER_STATUSES, default: 'pending' }) status: OfferStatus;
  @Prop({ type: OfferCounterSchema }) counter?: OfferCounter;
  /** The price both sides agreed, once accepted. */
  @Prop() agreedAmount?: number;
  @Prop() respondedAt?: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId }) orderId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type OfferDocument = HydratedDocument<Offer>;
export const OfferSchema = SchemaFactory.createForClass(Offer);
OfferSchema.index({ conversationId: 1, createdAt: -1 });
OfferSchema.index({ buyerId: 1, productId: 1, status: 1 });
