import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

/**
 * The sandbox provider's own ledger, standing in for Paystack's side of the
 * world in development and tests. Nothing in the marketplace reads it.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'sandbox_records' })
export class SandboxRecord {
  @Prop({ type: String, enum: ['charge', 'refund', 'recipient', 'transfer'], required: true }) kind: 'charge' | 'refund' | 'recipient' | 'transfer';
  @Prop({ required: true }) reference: string;
  @Prop({ required: true }) status: string;
  @Prop({ default: 0 }) amount: number;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type SandboxRecordDocument = HydratedDocument<SandboxRecord>;
export const SandboxRecordSchema = SchemaFactory.createForClass(SandboxRecord);
SandboxRecordSchema.index({ kind: 1, reference: 1 }, { unique: true });
