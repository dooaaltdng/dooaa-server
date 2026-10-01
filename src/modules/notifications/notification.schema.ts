import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

export const NOTIFICATION_TONES = ['blue', 'green', 'red'] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

/** The bell: one row per recipient. Old rows expire after 120 days. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'notifications' })
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) recipientId: Types.ObjectId;
  @Prop({ type: String, enum: ['user', 'staff'], required: true }) recipientType: 'user' | 'staff';
  /** order.shipped, message.new, dispute.opened, listing.flagged… */
  @Prop({ required: true }) type: string;
  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) body: string;
  @Prop({ type: String, enum: NOTIFICATION_TONES, default: 'blue' }) tone: NotificationTone;
  /** Where tapping it goes, as an app path ("/orders/123-456"). */
  @Prop() link?: string;
  @Prop({ type: MongooseSchema.Types.Mixed }) data?: Record<string, unknown>;
  @Prop() readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ recipientId: 1, recipientType: 1, createdAt: -1 });
NotificationSchema.index({ recipientId: 1, readAt: 1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 120 * 86_400 });
