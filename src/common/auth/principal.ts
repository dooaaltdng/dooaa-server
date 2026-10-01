import type {
  AccountStatus,
  IdentityStatus,
  StaffRole,
  UserRole,
  VerificationLevel,
} from '../domain';
import type { StaffStatus } from '../../modules/staff/schemas/staff.schema';

/** The signed-in marketplace account, as attached to `req.user`. */
export type AuthUser = {
  kind: 'user';
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: UserRole | null;
  emailVerified: boolean;
  identity: IdentityStatus;
  verificationLevel: VerificationLevel;
  status: AccountStatus;
  tokenVersion: number;
};

/** The signed-in console account, as attached to `req.staff`. */
export type AuthStaff = {
  kind: 'staff';
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: StaffRole;
  status: StaffStatus;
  tokenVersion: number;
};

export type Principal = AuthUser | AuthStaff;

export type AccessTokenPayload = { sub: string; typ: 'user' | 'staff'; ver: number };
