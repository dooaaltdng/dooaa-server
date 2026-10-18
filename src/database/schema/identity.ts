import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { DEFAULT_NOTIFICATION_PREFS } from '../../common/domain';
import { primaryId, timestamps, timestamptz } from './columns';
import {
  accountStatus,
  gender,
  identityStatus,
  oauthProvider,
  otpChannel,
  otpPurpose,
  staffRole,
  staffStatus,
  subjectType,
  userRole,
  verificationLevel,
} from './enums';
import type { NotificationPrefs } from './values';

/** Marketplace accounts: buyers and sellers. */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    /** Always stored lower-cased (see the check below). */
    email: text().notNull(),
    /** E.164, e.g. +2349027293293; empty when not given. */
    phone: text().notNull().default(''),
    passwordHash: text().notNull(),
    role: userRole(),
    emailVerified: boolean().notNull().default(false),
    phoneVerified: boolean().notNull().default(false),
    identity: identityStatus().notNull().default('unverified'),
    verificationLevel: verificationLevel().notNull().default('normal'),
    status: accountStatus().notNull().default('active'),
    statusReason: text(),
    avatarUrl: text(),
    gender: gender(),
    /** City from the profile form. */
    location: text(),
    /** State the location rolls up to — the console's region facet. */
    region: text(),

    /* The public face of a seller's store. */
    sellerStoreName: text(),
    sellerDispatchDays: integer().notNull().default(3),
    sellerResponseLabel: text().notNull().default('Typically responds within a few hours'),
    sellerDeliveryLabel: text().notNull().default('Nationwide Delivery (1-3 business days within Lagos)'),
    /** How many listings may be live or in review at once. Null is unlimited. */
    sellerListingLimit: integer(),

    /* Counters kept current by the modules that change them. */
    statsPurchases: integer().notNull().default(0),
    statsActiveListings: integer().notNull().default(0),
    statsSales: integer().notNull().default(0),
    statsRatingAverage: doublePrecision().notNull().default(0),
    statsRatingCount: integer().notNull().default(0),

    notificationPrefs: jsonb().$type<NotificationPrefs>().notNull().default(DEFAULT_NOTIFICATION_PREFS),

    lastLoginAt: timestamptz(),
    failedSignIns: integer().notNull().default(0),
    lockedUntil: timestamptz(),
    /** Bumped on password change and ban: every token minted before is void. */
    tokenVersion: integer().notNull().default(0),
    termsAcceptedAt: timestamptz(),
    privacyAcceptedAt: timestamptz(),
    closedAt: timestamptz(),
    closeReason: text(),
    closeNotes: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    index('users_role_status_created_idx').on(t.role, t.status, t.createdAt.desc()),
    index('users_phone_idx').on(t.phone),
    index('users_identity_idx').on(t.identity),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_seller_dispatch_days_range', sql`${t.sellerDispatchDays} between 1 and 30`),
    check('users_seller_listing_limit_nonnegative', sql`${t.sellerListingLimit} >= 0`),
  ],
);

/** A Google or Facebook account that signs in to a user. */
export const userOauthIdentities = pgTable(
  'user_oauth_identities',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProvider().notNull(),
    /** The provider's stable account id (Google `sub`, Facebook `id`). */
    subject: text().notNull(),
    email: text(),
    linkedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_oauth_identities_provider_subject_key').on(t.provider, t.subject), index('user_oauth_identities_user_idx').on(t.userId)],
);

/** Console accounts. The console is invite-only: there is no sign-up path. */
export const staff = pgTable(
  'staff',
  {
    id: primaryId(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    email: text().notNull(),
    /** Unset until the invitation is accepted. */
    passwordHash: text(),
    role: staffRole().notNull(),
    /** Shown under the name in the topbar. */
    title: text(),
    avatarUrl: text(),
    status: staffStatus().notNull().default('active'),
    /** Hash of the one-time invitation or password-reset link. */
    inviteTokenHash: text(),
    inviteExpiresAt: timestamptz(),
    invitedBy: uuid().references((): AnyPgColumn => staff.id, { onDelete: 'set null' }),
    lastLoginAt: timestamptz(),
    lastSeenAt: timestamptz(),
    failedSignIns: integer().notNull().default(0),
    lockedUntil: timestamptz(),
    tokenVersion: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('staff_email_key').on(t.email),
    uniqueIndex('staff_invite_token_hash_key').on(t.inviteTokenHash),
    check('staff_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

/**
 * A refresh-token session for a user or a staff member. Only a hash of the
 * token is stored. Refreshing rotates the token; presenting a rotated
 * (revoked) token again is treated as theft and revokes the whole family.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    subjectType: subjectType().notNull(),
    /** A users.id or staff.id, depending on subject_type. */
    subjectId: uuid().notNull(),
    tokenHash: text().notNull(),
    /** Every rotation of one sign-in shares a family id. */
    family: text().notNull(),
    expiresAt: timestamptz().notNull(),
    revokedAt: timestamptz(),
    replacedAt: timestamptz(),
    userAgent: text(),
    ip: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_subject_idx').on(t.subjectId, t.subjectType),
    index('sessions_family_idx').on(t.family),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * The one-time code the OAuth callback hands the client in its redirect. The
 * client trades it for tokens with a POST, so tokens never travel in a URL.
 */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: primaryId(),
    codeHash: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isNewUser: boolean().notNull().default(false),
    next: text().notNull().default(''),
    expiresAt: timestamptz().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_grants_code_hash_key').on(t.codeHash), index('oauth_grants_expires_at_idx').on(t.expiresAt)],
);

/** A one-time code. Only its hash is stored; expired rows are purged by a job. */
export const otps = pgTable(
  'otps',
  {
    id: primaryId(),
    /** What the code is looked up by: an email, a phone, or `user:<id>`. */
    key: text().notNull(),
    purpose: otpPurpose().notNull(),
    /** Binds a code to one object, e.g. the order a release code confirms. */
    context: text().notNull().default(''),
    channel: otpChannel().notNull(),
    codeHash: text().notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    attempts: integer().notNull().default(0),
    expiresAt: timestamptz().notNull(),
    consumedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [index('otps_lookup_idx').on(t.key, t.purpose, t.context, t.createdAt.desc()), index('otps_expires_at_idx').on(t.expiresAt)],
);
