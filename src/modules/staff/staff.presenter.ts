import type { StaffRole, StaffStatus } from '../../common/domain';
import { STAFF_ROLE_LABEL } from '../../common/domain';
import type { StaffMember } from './staff.model';

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

export function toStaffSession(member: StaffMember, online = false): StaffSession {
  return {
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    role: member.role,
    title: member.title || STAFF_ROLE_LABEL[member.role],
    avatar: member.avatarUrl ?? null,
    online,
    status: member.status,
    lastSeenAt: member.lastSeenAt?.toISOString() ?? null,
  };
}
