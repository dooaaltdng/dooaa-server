import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

/**
 * A card the buyer paid with, as the provider's reusable authorization. The
 * card number never reaches DOOAA; the authorization code is a provider token
 * and is never returned by the API.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'saved_cards' })
export class SavedCard {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ required: true }) provider: string;
  @Prop({ required: true, select: false }) authorizationCode: string;
  /** Stable per physical card at the provider; used to de-duplicate. */
  @Prop() signature?: string;
  @Prop() last4?: string;
  @Prop() brand?: string;
  @Prop() bank?: string;
  @Prop() expMonth?: string;
  @Prop() expYear?: string;
  @Prop({ default: false }) primary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type SavedCardDocument = HydratedDocument<SavedCard>;
export const SavedCardSchema = SchemaFactory.createForClass(SavedCard);
SavedCardSchema.index({ userId: 1, signature: 1 }, { unique: true, partialFilterExpression: { signature: { $type: 'string' } } });
