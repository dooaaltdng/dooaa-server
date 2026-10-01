import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/** One tile on the landing rail ("Vehicles", "Electronics"…), which uses its own labels. */
@Schema({ _id: false })
export class HomeTile {
  @Prop({ required: true }) label: string;
  @Prop({ required: true }) order: number;
  @Prop() image?: string;
}
const HomeTileSchema = SchemaFactory.createForClass(HomeTile);

@Schema({ ...SCHEMA_OPTIONS, collection: 'categories' })
export class Category {
  /** The route segment: /categories/[slug]. */
  @Prop({ required: true, lowercase: true, trim: true }) slug: string;
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ trim: true, default: '' }) description: string;
  @Prop({ default: '' }) image: string;
  @Prop({ default: 0 }) order: number;
  @Prop({ default: true }) active: boolean;
  /** A category may appear on the landing rail more than once, under different labels. */
  @Prop({ type: [HomeTileSchema], default: [] }) home: HomeTile[];
  createdAt: Date;
  updatedAt: Date;
}

export type CategoryDocument = HydratedDocument<Category>;
export const CategorySchema = SchemaFactory.createForClass(Category);
CategorySchema.index({ slug: 1 }, { unique: true });
CategorySchema.index({ active: 1, order: 1 });
