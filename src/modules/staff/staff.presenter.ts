import type { StaffRole } from '../../common/domain';
import { STAFF_ROLE_LABEL } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import type { Staff, StaffStatus } from './schemas/staff.schema';

/** The console's `Session` shape — never carries the password. */
export type StaffSession = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: StaffRole;
  title: string;
  avatar: string | null;
  online: boolean;
  status: StaffStatus;
  lastSeenAt: string | null;
};

export function toStaffSession(member: Lean<Staff>, online = false): StaffSession {
  return {
    id: String(member._id),
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    role: member.role,
    title: member.title || STAFF_ROLE_LABEL[member.role],
    avatar: member.avatarUrl ?? null,
    online,
    status: member.status,
    lastSeenAt: member.lastSeenAt ? new Date(member.lastSeenAt).toISOString() : null,
  };
}
