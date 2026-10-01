import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { MESSAGE_KINDS, type MessageKind } from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

/** The listing a thread is about, pinned at the top of the chat. */
@Schema({ _id: false })
export class ConversationSubject {
  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) summary: string;
  @Prop({ default: '' }) image: string;
  @Prop({ default: 0 }) price: number;
}
const ConversationSubjectSchema = SchemaFactory.createForClass(ConversationSubject);

@Schema({ _id: false })
export class LastMessage {
  @Prop({ default: '' }) preview: string;
  @Prop({ type: String, enum: MESSAGE_KINDS }) kind?: MessageKind;
  @Prop() at?: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId }) senderId?: Types.ObjectId;
}
const LastMessageSchema = SchemaFactory.createForClass(LastMessage);

/** A buyer and a seller talking, usually about one listing and often one order. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'conversations' })
export class Conversation {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) buyerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) sellerId: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) productId?: Types.ObjectId;
  @Prop({ type: ConversationSubjectSchema }) subject?: ConversationSubject;
  /** The escrow order this thread follows, once the buyer pays. */
  @Prop({ type: MongooseSchema.Types.ObjectId }) orderId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) disputeId?: Types.ObjectId;
  @Prop({ type: LastMessageSchema, default: () => ({}) }) lastMessage: LastMessage;
  @Prop({ default: 0 }) buyerUnread: number;
  @Prop({ default: 0 }) sellerUnread: number;
  @Prop() buyerReadAt?: Date;
  @Prop() sellerReadAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ConversationDocument = HydratedDocument<Conversation>;
export const ConversationSchema = SchemaFactory.createForClass(Conversation);
ConversationSchema.index({ buyerId: 1, 'lastMessage.at': -1 });
ConversationSchema.index({ sellerId: 1, 'lastMessage.at': -1 });
ConversationSchema.index({ buyerId: 1, sellerId: 1, productId: 1, orderId: 1 });
ConversationSchema.index({ orderId: 1 });
