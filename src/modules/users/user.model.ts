import { getTableColumns } from 'drizzle-orm';
import type { AccountStatus, Gender, IdentityStatus, NotificationPrefs, UserRole, VerificationLevel } from '../../common/domain';
import { users } from '../../database/schema';

/** The public face of a seller's store, shown on listings and in chat. */
export type SellerProfile = {
  storeName: string | null;
  /** "Delivery within 3 days". */
  dispatchDays: number;
  /** "Typically responds within an hour". */
  responseLabel: string;
  /** "Nationwide Delivery (1-3 business days within Lagos)". */
  deliveryLabel: string;
  /** Set by the console ("Limit seller listing"). Null is unlimited. */
  listingLimit: number | null;
};

export type UserStats = {
  /** Paid orders placed as a buyer — the console's "Total Purchase". */
  purchases: number;
  activeListings: number;
  sales: number;
  ratingAverage: number;
  ratingCount: number;
};

/** A marketplace account as the services see it. The password hash is never part of it. */
export type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  identity: IdentityStatus;
  verificationLevel: VerificationLevel;
  status: AccountStatus;
  statusReason: string | null;
  avatarUrl: string | null;
  gender: Gender | null;
  location: string | null;
  region: string | null;
  seller: SellerProfile;
  stats: UserStats;
  notificationPrefs: NotificationPrefs;
  lastLoginAt: Date | null;
  failedSignIns: number;
  lockedUntil: Date | null;
  tokenVersion: number;
  termsAcceptedAt: Date | null;
  privacyAcceptedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  closeNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const { passwordHash: _passwordHash, ...columns } = getTableColumns(users);

/** Every user column except the password hash — what reads select. */
export const userColumns = columns;

export type UserRow = Omit<typeof users.$inferSelect, 'passwordHash'>;

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    role: row.role,
    emailVerified: row.emailVerified,
    phoneVerified: row.phoneVerified,
    identity: row.identity,
    verificationLevel: row.verificationLevel,
    status: row.status,
    statusReason: row.statusReason,
    avatarUrl: row.avatarUrl,
    gender: row.gender,
    location: row.location,
    region: row.region,
    seller: {
      storeName: row.sellerStoreName,
      dispatchDays: row.sellerDispatchDays,
      responseLabel: row.sellerResponseLabel,
      deliveryLabel: row.sellerDeliveryLabel,
      listingLimit: row.sellerListingLimit,
    },
    stats: {
      purchases: row.statsPurchases,
      activeListings: row.statsActiveListings,
      sales: row.statsSales,
      ratingAverage: row.statsRatingAverage,
      ratingCount: row.statsRatingCount,
    },
    notificationPrefs: row.notificationPrefs,
    lastLoginAt: row.lastLoginAt,
    failedSignIns: row.failedSignIns,
    lockedUntil: row.lockedUntil,
    tokenVersion: row.tokenVersion,
    termsAcceptedAt: row.termsAcceptedAt,
    privacyAcceptedAt: row.privacyAcceptedAt,
    closedAt: row.closedAt,
    closeReason: row.closeReason,
    closeNotes: row.closeNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
