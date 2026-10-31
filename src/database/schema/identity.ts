import {
  DEFAULT_NOTIFICATION_PREFS,
  type AccountStatus,
  type Gender,
  type IdentityStatus,
  type OtpChannel,
  type OtpPurpose,
  type StaffRole,
  type StaffStatus,
  type SubjectType,
  type UserRole,
  type VerificationLevel,
} from '../../common/domain';
import { index, table } from '../database';
import type { NotificationPrefs } from './values';

type Timestamps = { createdAt: Date; updatedAt: Date };

/** Marketplace accounts: buyers and sellers. */
export type UserRow = Timestamps & {
  id: string;
  firstName: string;
  lastName: string;
  /** Always stored lower-cased. */
  email: string;
  /** E.164, e.g. +2349027293293; empty when not given. */
  phone: string;
  passwordHash: string;
  role: UserRole | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  identity: IdentityStatus;
  verificationLevel: VerificationLevel;
  status: AccountStatus;
  statusReason: string | null;
  avatarUrl: string | null;
  gender: Gender | null;
  /** City from the profile form. */
  location: string | null;
  /** State the location rolls up to — the console's region facet. */
  region: string | null;
  /* The public face of a seller's store. */
  sellerStoreName: string | null;
  sellerDispatchDays: number;
  sellerResponseLabel: string;
  sellerDeliveryLabel: string;
  /** How many listings may be live or in review at once. Null is unlimited. */
  sellerListingLimit: number | null;
  /* Counters kept current by the modules that change them. */
  statsPurchases: number;
  statsActiveListings: number;
  statsSales: number;
  statsRatingAverage: number;
  statsRatingCount: number;
  notificationPrefs: NotificationPrefs;
  lastLoginAt: Date | null;
  failedSignIns: number;
  lockedUntil: Date | null;
  /** Bumped on password change and ban: every token minted before is void. */
  tokenVersion: number;
  termsAcceptedAt: Date | null;
  privacyAcceptedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  closeNotes: string | null;
};

export const users = table<UserRow>()('users', {
  key: 'id',
  defaults: () => ({
    phone: '',
    emailVerified: false,
    phoneVerified: false,
    identity: 'unverified' as IdentityStatus,
    verificationLevel: 'normal' as VerificationLevel,
    status: 'active' as AccountStatus,
    sellerDispatchDays: 3,
    sellerResponseLabel: 'Typically responds within a few hours',
    sellerDeliveryLabel: 'Nationwide Delivery (1-3 business days within Lagos)',
    statsPurchases: 0,
    statsActiveListings: 0,
    statsSales: 0,
    statsRatingAverage: 0,
    statsRatingCount: 0,
    notificationPrefs: structuredClone(DEFAULT_NOTIFICATION_PREFS),
    failedSignIns: 0,
    tokenVersion: 0,
  }),
  nullable: [
    'role',
    'statusReason',
    'avatarUrl',
    'gender',
    'location',
    'region',
    'sellerStoreName',
    'sellerListingLimit',
    'lastLoginAt',
    'lockedUntil',
    'termsAcceptedAt',
    'privacyAcceptedAt',
    'closedAt',
    'closeReason',
    'closeNotes',
  ],
  indexes: [
    index('users_email_key', { email: 1 }, { unique: true }),
    index('users_role_status_created_idx', { role: 1, status: 1, createdAt: -1 }),
    index('users_phone_idx', { phone: 1 }),
    index('users_identity_idx', { identity: 1 }),
  ],
});

/** Console accounts. The console is invite-only: there is no sign-up path. */
export type StaffRow = Timestamps & {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Unset until the invitation is accepted. */
  passwordHash: string | null;
  role: StaffRole;
  /** Shown under the name in the topbar. */
  title: string | null;
  avatarUrl: string | null;
  status: StaffStatus;
  /** Hash of the one-time invitation or password-reset link. */
  inviteTokenHash: string | null;
  inviteExpiresAt: Date | null;
  invitedBy: string | null;
  lastLoginAt: Date | null;
  lastSeenAt: Date | null;
  failedSignIns: number;
  lockedUntil: Date | null;
  tokenVersion: number;
};

export const staff = table<StaffRow>()('staff', {
  key: 'id',
  defaults: () => ({ status: 'active' as StaffStatus, failedSignIns: 0, tokenVersion: 0 }),
  nullable: ['passwordHash', 'title', 'avatarUrl', 'inviteTokenHash', 'inviteExpiresAt', 'invitedBy', 'lastLoginAt', 'lastSeenAt', 'lockedUntil'],
  indexes: [
    index('staff_email_key', { email: 1 }, { unique: true }),
    index('staff_invite_token_hash_key', { inviteTokenHash: 1 }, { unique: true, partialFilterExpression: { inviteTokenHash: { $type: 'string' } } }),
  ],
});

/**
 * A refresh-token session for a user or a staff member. Only a hash of the
 * token is stored. Refreshing rotates the token; presenting a rotated
 * (revoked) token again is treated as theft and revokes the whole family.
 */
export type SessionRow = Timestamps & {
  id: string;
  subjectType: SubjectType;
  /** A users.id or staff.id, depending on subjectType. */
  subjectId: string;
  tokenHash: string;
  /** Every rotation of one sign-in shares a family id. */
  family: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
};

export const sessions = table<SessionRow>()('sessions', {
  key: 'id',
  nullable: ['revokedAt', 'replacedAt', 'userAgent', 'ip'],
  indexes: [
    index('sessions_token_hash_key', { tokenHash: 1 }, { unique: true }),
    index('sessions_subject_idx', { subjectId: 1, subjectType: 1 }),
    index('sessions_family_idx', { family: 1 }),
    index('sessions_expires_at_idx', { expiresAt: 1 }),
  ],
});

/** A one-time code. Only its hash is stored; expired rows are purged by a job. */
export type OtpRow = Timestamps & {
  id: string;
  /** What the code is looked up by: an email, a phone, or `user:<id>`. */
  key: string;
  purpose: OtpPurpose;
  /** Binds a code to one object, e.g. the order a release code confirms. */
  context: string;
  channel: OtpChannel;
  codeHash: string;
  userId: string | null;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
};

export const otps = table<OtpRow>()('otps', {
  key: 'id',
  defaults: () => ({ context: '', attempts: 0 }),
  nullable: ['userId', 'consumedAt'],
  indexes: [index('otps_lookup_idx', { key: 1, purpose: 1, context: 1, createdAt: -1 }), index('otps_expires_at_idx', { expiresAt: 1 })],
});
