import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { STAFF_ROLES, type StaffRole } from '../../../common/domain';
import { SCHEMA_OPTIONS } from '../../../common/util/mongo';

export const STAFF_STATUSES = ['invited', 'active', 'disabled'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** Console accounts. The console is invite-only: there is no sign-up path. */
@Schema({ ...SCHEMA_OPTIONS, collection: 'staff' })
export class Staff {
  @Prop({ required: true, trim: true }) firstName: string;
  @Prop({ required: true, trim: true }) lastName: string;
  @Prop({ required: true, lowercase: true, trim: true }) email: string;
  @Prop({ select: false }) passwordHash?: string;
  @Prop({ type: String, enum: STAFF_ROLES, required: true }) role: StaffRole;
  /** Shown under the name in the topbar. */
  @Prop({ trim: true }) title?: string;
  @Prop() avatarUrl?: string;
  @Prop({ type: String, enum: STAFF_STATUSES, default: 'active' }) status: StaffStatus;
  @Prop({ select: false }) inviteTokenHash?: string;
  @Prop() inviteExpiresAt?: Date;
  @Prop() invitedBy?: string;
  @Prop() lastLoginAt?: Date;
  @Prop() lastSeenAt?: Date;
  @Prop({ default: 0 }) failedSignIns: number;
  @Prop() lockedUntil?: Date;
  @Prop({ default: 0 }) tokenVersion: number;

  createdAt: Date;
  updatedAt: Date;
}

export type StaffDocument = HydratedDocument<Staff>;
export const StaffSchema = SchemaFactory.createForClass(Staff);
StaffSchema.index({ email: 1 }, { unique: true });
