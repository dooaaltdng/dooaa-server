import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** Named sequences ("dispute" → #3790, #3791…). */
@Schema({ collection: 'counters', versionKey: false })
export class Counter {
  @Prop({ type: String }) _id: string;
  @Prop({ required: true, default: 0 }) seq: number;
}

export type CounterDocument = HydratedDocument<Counter>;
export const CounterSchema = SchemaFactory.createForClass(Counter);
