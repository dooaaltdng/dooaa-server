import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, SchemaTypes } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

export type SubjectType = 'user' | 'staff';

/**
 * A refresh-token session. Only a hash of the token is stored. Refreshing
 * rotates the token; presenting a rotated (revoked) token again is treated
 * as theft and revokes the whole family.
 */
@Schema({ ...SCHEMA_OPTIONS, collection: 'sessions' })
export class Session {
  @Prop({ type: SchemaTypes.ObjectId, required: true }) subjectId: Types.ObjectId;
  @Prop({ type: String, enum: ['user', 'staff'], required: true }) subjectType: SubjectType;
  @Prop({ required: true }) tokenHash: string;
  /** Every rotation of one sign-in shares a family id. */
  @Prop({ required: true }) family: string;
  @Prop({ required: true }) expiresAt: Date;
  @Prop() revokedAt?: Date;
  @Prop() replacedAt?: Date;
  @Prop() userAgent?: string;
  @Prop() ip?: string;

  createdAt: Date;
  updatedAt: Date;
}

export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ tokenHash: 1 }, { unique: true });
SessionSchema.index({ subjectId: 1, subjectType: 1 });
SessionSchema.index({ family: 1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
