import type { IdentityStatus, NotificationPrefs, UserRole } from '../../common/domain';
import { ALWAYS_ON_NOTIFICATIONS, DEFAULT_NOTIFICATION_PREFS } from '../../common/domain';
import type { User } from './user.model';

/** The signed-in account as the client renders it (`PublicUser` in its auth api). */
export type PublicUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: UserRole | null;
  /** Email confirmed through the OTP step. */
  verified: boolean;
  phoneVerified: boolean;
  identity: IdentityStatus;
  verificationLevel: User['verificationLevel'];
  status: User['status'];
  avatarUrl: string | null;
  gender: User['gender'] | null;
  location: string | null;
  storeName: string | null;
  notificationPrefs: NotificationPrefs;
  createdAt: string;
};

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    role: user.role ?? null,
    verified: Boolean(user.emailVerified),
    phoneVerified: Boolean(user.phoneVerified),
    identity: user.identity,
    verificationLevel: user.verificationLevel,
    status: user.status,
    avatarUrl: user.avatarUrl ?? null,
    gender: user.gender ?? null,
    location: user.location ?? null,
    storeName: user.seller.storeName,
    notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...(user.notificationPrefs ?? {}), ...ALWAYS_ON_NOTIFICATIONS },
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

/** The face a seller shows on listings and in chat. */
export type SellerCard = {
  id: string;
  name: string;
  storeName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  verificationLevel: User['verificationLevel'];
  location: string | null;
  joinedAt: string;
  rating: number;
  ratingCount: number;
};

export function toSellerCard(user: User): SellerCard {
  return {
    id: user.id,
    name: `${user.firstName} ${user.lastName}`.trim(),
    storeName: user.seller.storeName,
    avatarUrl: user.avatarUrl ?? null,
    verified: user.identity === 'verified',
    verificationLevel: user.verificationLevel,
    location: user.location ?? null,
    joinedAt: new Date(user.createdAt).toISOString(),
    rating: user.stats.ratingAverage,
    ratingCount: user.stats.ratingCount,
  };
}
