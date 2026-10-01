import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

@Schema({ _id: false })
export class CartLine {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) productId: Types.ObjectId;
  @Prop({ required: true, min: 1 }) quantity: number;
  @Prop({ default: () => new Date() }) addedAt: Date;
}
const CartLineSchema = SchemaFactory.createForClass(CartLine);

/** Where the order goes — the cart's Delivery Information panel. */
@Schema({ _id: false })
export class DeliveryInfo {
  @Prop({ required: true }) firstName: string;
  @Prop({ required: true }) lastName: string;
  @Prop({ required: true }) address: string;
  @Prop({ required: true }) city: string;
  @Prop({ default: '' }) state: string;
  @Prop({ default: '' }) zip: string;
  @Prop({ required: true }) phone: string;
  @Prop({ required: true }) email: string;
}
export const DeliveryInfoSchema = SchemaFactory.createForClass(DeliveryInfo);

@Schema({ ...SCHEMA_OPTIONS, collection: 'carts' })
export class Cart {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ type: [CartLineSchema], default: [] }) lines: CartLine[];
  @Prop() couponCode?: string;
  @Prop({ type: DeliveryInfoSchema }) delivery?: DeliveryInfo;
  createdAt: Date;
  updatedAt: Date;
}

export type CartDocument = HydratedDocument<Cart>;
export const CartSchema = SchemaFactory.createForClass(Cart);
CartSchema.index({ userId: 1 }, { unique: true });
