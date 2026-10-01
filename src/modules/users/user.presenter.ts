import type { IdentityStatus, NotificationPrefs, UserRole } from '../../common/domain';
import { DEFAULT_NOTIFICATION_PREFS } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import type { User } from './schemas/user.schema';

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

export function toPublicUser(user: Lean<User> | (User & { _id: unknown; createdAt: Date })): PublicUser {
  return {
    id: String(user._id),
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone ?? '',
    role: user.role ?? null,
    verified: Boolean(user.emailVerified),
    phoneVerified: Boolean(user.phoneVerified),
    identity: user.identity,
    verificationLevel: user.verificationLevel,
    status: user.status,
    avatarUrl: user.avatarUrl ?? null,
    gender: user.gender ?? null,
    location: user.location ?? null,
    storeName: user.seller?.storeName ?? null,
    notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...(user.notificationPrefs ?? {}) },
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

export function toSellerCard(user: Lean<User>): SellerCard {
  return {
    id: String(user._id),
    name: `${user.firstName} ${user.lastName}`.trim(),
    storeName: user.seller?.storeName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    verified: user.identity === 'verified',
    verificationLevel: user.verificationLevel,
    location: user.location ?? null,
    joinedAt: new Date(user.createdAt).toISOString(),
    rating: user.stats?.ratingAverage ?? 0,
    ratingCount: user.stats?.ratingCount ?? 0,
  };
}
