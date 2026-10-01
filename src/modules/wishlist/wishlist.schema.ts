import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

@Schema({ ...SCHEMA_OPTIONS, collection: 'wishlist_items' })
export class WishlistItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) productId: Types.ObjectId;
  /** "Restock alerts on" — tell me when this is back in stock. */
  @Prop({ default: false }) restockAlert: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WishlistItemDocument = HydratedDocument<WishlistItem>;
export const WishlistItemSchema = SchemaFactory.createForClass(WishlistItem);
WishlistItemSchema.index({ userId: 1, productId: 1 }, { unique: true });
WishlistItemSchema.index({ userId: 1, createdAt: -1 });
WishlistItemSchema.index({ productId: 1, restockAlert: 1 });
