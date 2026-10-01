import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

/** One document, `_id: 'platform'`, holding every section. */
@Schema({ collection: 'settings', timestamps: true, versionKey: false, minimize: false })
export class SettingsRecord {
  @Prop({ type: String }) _id: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) values: Record<string, unknown>;
  @Prop() updatedBy?: string;
  updatedAt: Date;
}

export type SettingsRecordDocument = HydratedDocument<SettingsRecord>;
export const SettingsRecordSchema = SchemaFactory.createForClass(SettingsRecord);
