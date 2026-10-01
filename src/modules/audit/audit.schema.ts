import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/** Permissions say who may; this says who did. Written by every destructive console verb. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'audit_log' })
export class AuditEntry {
  @Prop() actorId?: string;
  @Prop({ required: true }) actorName: string;
  @Prop() actorRole?: string;
  @Prop({ required: true }) action: string;
  @Prop({ required: true }) target: string;
  @Prop() targetType?: string;
  @Prop() targetId?: string;
  /** Marks the superadmin-only verbs, which read differently in a log. */
  @Prop({ default: false }) elevated: boolean;
  @Prop({ type: MongooseSchema.Types.Mixed }) meta?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type AuditEntryDocument = HydratedDocument<AuditEntry>;
export const AuditEntrySchema = SchemaFactory.createForClass(AuditEntry);
AuditEntrySchema.index({ createdAt: -1 });
AuditEntrySchema.index({ actorId: 1, createdAt: -1 });
AuditEntrySchema.index({ targetType: 1, targetId: 1 });
