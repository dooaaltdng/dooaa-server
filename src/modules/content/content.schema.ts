import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

/** A page the console publishes (About Us, Help Center, the four policies). */
@Schema({ ...SCHEMA_OPTIONS, collection: 'content_pages' })
export class ContentPage {
  @Prop({ required: true, lowercase: true, trim: true }) slug: string;
  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) summary: string;
  /** Sanitised rich text, exactly what the editor saves. */
  @Prop({ default: '' }) body: string;
  @Prop() updatedBy?: string;
  @Prop({ default: 0 }) order: number;
  createdAt: Date;
  updatedAt: Date;
}
export type ContentPageDocument = HydratedDocument<ContentPage>;
export const ContentPageSchema = SchemaFactory.createForClass(ContentPage);
ContentPageSchema.index({ slug: 1 }, { unique: true });

/** Every publish keeps the body it replaced, so a page can be restored. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'content_versions' })
export class ContentVersion {
  @Prop({ required: true }) slug: string;
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) body: string;
  @Prop({ required: true }) author: string;
  @Prop() authorId?: string;
  @Prop({ default: '' }) note: string;
  createdAt: Date;
  updatedAt: Date;
}
export type ContentVersionDocument = HydratedDocument<ContentVersion>;
export const ContentVersionSchema = SchemaFactory.createForClass(ContentVersion);
ContentVersionSchema.index({ slug: 1, createdAt: -1 });
