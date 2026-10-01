import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { MEETUP_STATUSES, MESSAGE_KINDS, type MeetupStatus, type MessageKind } from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

@Schema({ _id: false })
export class MessageMedia {
  @Prop({ required: true }) url: string;
  @Prop() posterUrl?: string;
  @Prop() name?: string;
  @Prop() size?: number;
  @Prop() format?: string;
}
const MessageMediaSchema = SchemaFactory.createForClass(MessageMedia);

@Schema({ _id: false })
export class MessageProduct {
  @Prop({ type: MongooseSchema.Types.ObjectId }) productId?: Types.ObjectId;
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) price: number;
  @Prop({ default: '' }) image: string;
}
const MessageProductSchema = SchemaFactory.createForClass(MessageProduct);

/** "Propose a Meetup": a place, a day and a time window. */
@Schema({ _id: false })
export class MessageMeetup {
  @Prop({ required: true }) venue: string;
  @Prop({ default: '' }) address: string;
  /** YYYY-MM-DD. */
  @Prop({ required: true }) date: string;
  /** HH:MM, 24-hour. */
  @Prop({ required: true }) from: string;
  @Prop({ required: true }) to: string;
  @Prop() photo?: string;
  @Prop({ type: String, enum: MEETUP_STATUSES, default: 'proposed' }) status: MeetupStatus;
  @Prop() respondedAt?: Date;
}
const MessageMeetupSchema = SchemaFactory.createForClass(MessageMeetup);

@Schema({ ...SCHEMA_OPTIONS, collection: 'messages' })
export class Message {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) conversationId: Types.ObjectId;
  /** Absent for platform system lines. */
  @Prop({ type: MongooseSchema.Types.ObjectId }) senderId?: Types.ObjectId;
  @Prop({ type: String, enum: ['buyer', 'seller', 'staff', 'system'], required: true }) senderRole: 'buyer' | 'seller' | 'staff' | 'system';
  @Prop({ type: String, enum: MESSAGE_KINDS, required: true }) kind: MessageKind;
  @Prop({ default: '' }) body: string;
  /** The highlighted lead-in on a system line ("Item marked as received."). */
  @Prop() systemLead?: string;
  @Prop({ type: MessageMediaSchema }) media?: MessageMedia;
  @Prop({ type: MessageProductSchema }) product?: MessageProduct;
  @Prop({ type: MongooseSchema.Types.ObjectId }) offerId?: Types.ObjectId;
  @Prop({ type: MessageMeetupSchema }) meetup?: MessageMeetup;
  /** The red dispute panel: who raised it and why. */
  @Prop({ type: Object }) dispute?: { by: string; reason: string };
  createdAt: Date;
  updatedAt: Date;
}

export type MessageDocument = HydratedDocument<Message>;
export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
