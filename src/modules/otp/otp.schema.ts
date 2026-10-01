import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, SchemaTypes } from 'mongoose';
import { SCHEMA_OPTIONS } from '../../common/util/mongo';

export const OTP_PURPOSES = ['verify-email', 'reset-password', 'change-password', 'confirm-release', 'verify-phone'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const OTP_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type OtpChannel = (typeof OTP_CHANNELS)[number];

/** A one-time code. Only its hash is stored; it expires on its own via TTL. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'otps' })
export class Otp {
  /** What the code is looked up by: an email, a phone, or a user id. */
  @Prop({ required: true }) key: string;
  @Prop({ type: String, enum: OTP_PURPOSES, required: true }) purpose: OtpPurpose;
  /** Binds a code to one object, e.g. the order a release code confirms. */
  @Prop({ default: '' }) context: string;
  @Prop({ type: String, enum: OTP_CHANNELS, required: true }) channel: OtpChannel;
  @Prop({ required: true }) codeHash: string;
  @Prop({ type: SchemaTypes.ObjectId }) userId?: Types.ObjectId;
  @Prop({ default: 0 }) attempts: number;
  @Prop({ required: true }) expiresAt: Date;
  @Prop() consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type OtpDocument = HydratedDocument<Otp>;
export const OtpSchema = SchemaFactory.createForClass(Otp);
OtpSchema.index({ key: 1, purpose: 1, context: 1, createdAt: -1 });
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
