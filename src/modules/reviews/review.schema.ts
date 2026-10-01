import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

@Schema({ _id: false })
export class ReviewAspects {
  @Prop({ min: 1, max: 5 }) communication?: number;
  @Prop({ min: 1, max: 5 }) valueForMoney?: number;
  @Prop({ min: 1, max: 5 }) itemAsDescribed?: number;
  @Prop({ min: 1, max: 5 }) shippingSpeed?: number;
  @Prop({ min: 1, max: 5 }) professionalism?: number;
  @Prop({ min: 1, max: 5 }) responsiveness?: number;
}
const ReviewAspectsSchema = SchemaFactory.createForClass(ReviewAspects);

@Schema({ _id: false })
export class ReviewResponse {
  @Prop({ required: true }) body: string;
  @Prop({ required: true }) at: Date;
}
const ReviewResponseSchema = SchemaFactory.createForClass(ReviewResponse);

/** "Rate your experience with …" — one per completed order, always a verified purchase. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'reviews' })
export class Review {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) orderId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) buyerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] }) productIds: Types.ObjectId[];
  @Prop({ required: true, min: 1, max: 5 }) rating: number;
  @Prop({ type: ReviewAspectsSchema, default: () => ({}) }) aspects: ReviewAspects;
  @Prop({ default: '' }) body: string;
  @Prop({ type: ReviewResponseSchema }) response?: ReviewResponse;
  /** Hidden by moderation; kept for the record but out of every average and list. */
  @Prop({ default: false }) hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ReviewDocument = HydratedDocument<Review>;
export const ReviewSchema = SchemaFactory.createForClass(Review);
ReviewSchema.index({ orderId: 1 }, { unique: true });
ReviewSchema.index({ sellerId: 1, hidden: 1, createdAt: -1 });
ReviewSchema.index({ productIds: 1, hidden: 1, createdAt: -1 });
