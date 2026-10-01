import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/** A platform discount code. DOOAA funds the discount; sellers are paid in full. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'coupons' })
export class Coupon {
  @Prop({ required: true, uppercase: true, trim: true }) code: string;
  @Prop({ trim: true, default: '' }) description: string;
  @Prop({ type: String, enum: ['percent', 'fixed'], required: true }) type: 'percent' | 'fixed';
  @Prop({ required: true, min: 0 }) value: number;
  @Prop() maxDiscount?: number;
  @Prop() minSubtotal?: number;
  @Prop({ default: true }) active: boolean;
  @Prop() startsAt?: Date;
  @Prop() expiresAt?: Date;
  /** Total redemptions allowed across all buyers; unset means unlimited. */
  @Prop() maxRedemptions?: number;
  @Prop({ default: 0 }) redemptions: number;
  createdAt: Date;
  updatedAt: Date;
}

export type CouponDocument = HydratedDocument<Coupon>;
export const CouponSchema = SchemaFactory.createForClass(Coupon);
CouponSchema.index({ code: 1 }, { unique: true });
