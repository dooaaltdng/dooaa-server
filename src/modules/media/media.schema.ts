import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, SchemaTypes } from 'mongoose';
import { MEDIA_PURPOSES, type MediaPurpose } from '../../common/domain';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

export const MEDIA_KINDS = ['image', 'video', 'file'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaVisibility = 'public' | 'private';

@Schema({ ...SCHEMA_OPTIONS, collection: 'media' })
export class Media {
  @Prop({ type: SchemaTypes.ObjectId, required: true }) ownerId: Types.ObjectId;
  @Prop({ type: String, enum: ['user', 'staff'], required: true }) ownerType: 'user' | 'staff';
  @Prop({ type: String, enum: MEDIA_PURPOSES, required: true }) purpose: MediaPurpose;
  @Prop({ type: String, enum: MEDIA_KINDS, required: true }) kind: MediaKind;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) mimeType: string;
  @Prop({ required: true }) size: number;
  @Prop({ type: String, enum: ['public', 'private'], required: true }) visibility: MediaVisibility;
  @Prop({ required: true }) storageKey: string;
  /** Permanent URL for public files; private files are reached through signed links. */
  @Prop() url?: string;
  /** A still frame for videos, used as the chat bubble's poster. */
  @Prop() posterUrl?: string;
  @Prop({ type: String, enum: ['cloudinary', 'local', 'memory'], required: true }) provider: 'cloudinary' | 'local' | 'memory';
  createdAt: Date;
  updatedAt: Date;
}

export type MediaDocument = HydratedDocument<Media>;
export const MediaSchema = SchemaFactory.createForClass(Media);
MediaSchema.index({ ownerId: 1, createdAt: -1 });
MediaSchema.index({ url: 1 });
MediaSchema.index({ storageKey: 1 }, { unique: true });
