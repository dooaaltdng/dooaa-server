import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  ACCOUNT_STATUSES,
  DEFAULT_NOTIFICATION_PREFS,
  GENDERS,
  IDENTITY_STATUSES,
  USER_ROLES,
  VERIFICATION_LEVELS,
  type AccountStatus,
  type Gender,
  type IdentityStatus,
  type NotificationPrefs,
  type UserRole,
  type VerificationLevel,
} from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

/** The public face of a seller's store, shown on listings and in chat. */
@Schema({ _id: false })
export class SellerProfile {
  @Prop({ trim: true, maxlength: 80 }) storeName?: string;
  /** "Delivery within 3 days". */
  @Prop({ type: Number, min: 1, max: 30, default: 3 }) dispatchDays: number;
  /** "Typically responds within an hour". */
  @Prop({ trim: true, default: 'Typically responds within a few hours' }) responseLabel: string;
  /** "Nationwide Delivery (1-3 business days within Lagos)". */
  @Prop({ trim: true, default: 'Nationwide Delivery (1-3 business days within Lagos)' }) deliveryLabel: string;
  /** Set by the console ("Limit seller listing"): how many listings may be live or in review at once. Null is unlimited. */
  @Prop({ type: Number, min: 0, default: null }) listingLimit?: number | null;
}
const SellerProfileSchema = SchemaFactory.createForClass(SellerProfile);

@Schema({ _id: false })
export class UserStats {
  /** Paid orders placed as a buyer — the console's "Total Purchase". */
  @Prop({ default: 0 }) purchases: number;
  @Prop({ default: 0 }) activeListings: number;
  @Prop({ default: 0 }) sales: number;
  @Prop({ default: 0 }) ratingAverage: number;
  @Prop({ default: 0 }) ratingCount: number;
}
const UserStatsSchema = SchemaFactory.createForClass(UserStats);

@Schema({ ...SCHEMA_OPTIONS, collection: 'users' })
export class User {
  @Prop({ required: true, trim: true, maxlength: 60 }) firstName: string;
  @Prop({ required: true, trim: true, maxlength: 60 }) lastName: string;
  @Prop({ required: true, lowercase: true, trim: true }) email: string;
  /** E.164, e.g. +2349027293293. */
  @Prop({ trim: true, default: '' }) phone: string;
  @Prop({ required: true, select: false }) passwordHash: string;

  @Prop({ type: String, enum: [...USER_ROLES, null], default: null }) role: UserRole | null;
  /** Email confirmed through the OTP step. */
  @Prop({ default: false }) emailVerified: boolean;
  @Prop({ default: false }) phoneVerified: boolean;
  @Prop({ type: String, enum: IDENTITY_STATUSES, default: 'unverified' }) identity: IdentityStatus;
  @Prop({ type: String, enum: VERIFICATION_LEVELS, default: 'normal' }) verificationLevel: VerificationLevel;
  @Prop({ type: String, enum: ACCOUNT_STATUSES, default: 'active' }) status: AccountStatus;
  @Prop() statusReason?: string;

  @Prop() avatarUrl?: string;
  @Prop({ type: String, enum: GENDERS }) gender?: Gender;
  /** City from the profile form. */
  @Prop({ trim: true }) location?: string;
  /** State the location rolls up to — the console's region facet. */
  @Prop({ trim: true }) region?: string;

  @Prop({ type: SellerProfileSchema, default: () => ({}) }) seller: SellerProfile;
  @Prop({ type: UserStatsSchema, default: () => ({}) }) stats: UserStats;
  @Prop({ type: Object, default: () => ({ ...DEFAULT_NOTIFICATION_PREFS }) }) notificationPrefs: NotificationPrefs;

  @Prop() lastLoginAt?: Date;
  @Prop({ default: 0 }) failedSignIns: number;
  @Prop() lockedUntil?: Date;
  /** Bumped on password change and ban: every token minted before is void. */
  @Prop({ default: 0 }) tokenVersion: number;

  @Prop() termsAcceptedAt?: Date;
  @Prop() privacyAcceptedAt?: Date;

  @Prop() closedAt?: Date;
  @Prop() closeReason?: string;
  @Prop() closeNotes?: string;

  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ email: 1 }, { unique: true });
UserSchema.index({ role: 1, status: 1, createdAt: -1 });
UserSchema.index({ phone: 1 });
UserSchema.index({ identity: 1 });
