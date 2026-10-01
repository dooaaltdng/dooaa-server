import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/** Per-day counters (Lagos days). `site` rows have no seller. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'daily_stats' })
export class DailyStat {
  @Prop({ required: true }) day: string;
  @Prop({ type: String, enum: ['site', 'seller'], required: true }) scope: 'site' | 'seller';
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) sellerId: Types.ObjectId | null;
  @Prop({ default: 0 }) visits: number;
  @Prop({ default: 0 }) productViews: number;
  createdAt: Date;
  updatedAt: Date;
}
export type DailyStatDocument = HydratedDocument<DailyStat>;
export const DailyStatSchema = SchemaFactory.createForClass(DailyStat);
DailyStatSchema.index({ scope: 1, sellerId: 1, day: 1 }, { unique: true });

/** Remembers which visitors were already counted today, so a visit counts once per day. */
@Schema({ collection: 'visitor_days', versionKey: false })
export class VisitorDay {
  @Prop({ required: true }) visitorId: string;
  @Prop({ required: true }) day: string;
  @Prop({ required: true, default: () => new Date() }) at: Date;
}
export type VisitorDayDocument = HydratedDocument<VisitorDay>;
export const VisitorDaySchema = SchemaFactory.createForClass(VisitorDay);
VisitorDaySchema.index({ visitorId: 1, day: 1 }, { unique: true });
VisitorDaySchema.index({ at: 1 }, { expireAfterSeconds: 3 * 86_400 });
