import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

/**
 * The one-time code the callback hands the client in its redirect. The
 * client trades it for tokens with a POST, so tokens never travel in a URL.
 * Only the hash is stored, and it expires on its own.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'oauth_grants' })
export class OAuthGrant {
  @Prop({ required: true, unique: true }) codeHash: string;
  @Prop({ type: SchemaTypes.ObjectId, required: true }) userId: Types.ObjectId;
  @Prop({ default: false }) isNewUser: boolean;
  @Prop({ default: '' }) next: string;
  @Prop({ required: true }) expiresAt: Date;
  createdAt: Date;
}

export const OAuthGrantSchema = SchemaFactory.createForClass(OAuthGrant);
OAuthGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
