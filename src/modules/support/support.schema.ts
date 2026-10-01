import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SUPPORT_TOPICS } from '../../common/domain';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/** "Send us a mail" from the Contact page. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'support_tickets' })
export class SupportTicket {
  @Prop({ required: true }) reference: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) userId?: Types.ObjectId;
  @Prop({ required: true }) name: string;
  @Prop({ required: true, lowercase: true }) email: string;
  @Prop() orderReference?: string;
  @Prop({ type: String, enum: SUPPORT_TOPICS, required: true }) topic: string;
  @Prop({ required: true }) detail: string;
  @Prop({ type: [String], default: [] }) attachments: string[];
  @Prop({ type: String, enum: ['open', 'resolved'], default: 'open' }) status: 'open' | 'resolved';
  @Prop() resolvedAt?: Date;
  @Prop() resolvedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SupportTicketDocument = HydratedDocument<SupportTicket>;
export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);
SupportTicketSchema.index({ reference: 1 }, { unique: true });
SupportTicketSchema.index({ status: 1, createdAt: -1 });
