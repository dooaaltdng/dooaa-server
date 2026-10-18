import { staff } from '../../database/schema';

/** Fields reads leave out: the password and invitation hashes. */
export const staffOmit: ['passwordHash', 'inviteTokenHash'] = ['passwordHash', 'inviteTokenHash'];

/** A console account as the services see it. Secrets are never part of it. */
export type StaffMember = Omit<typeof staff.$inferSelect, 'passwordHash' | 'inviteTokenHash'>;

/** A stored row without its secrets. */
export function toStaff<T extends StaffMember>(row: T & { passwordHash?: unknown; inviteTokenHash?: unknown }): StaffMember {
  const { passwordHash: _passwordHash, inviteTokenHash: _inviteTokenHash, ...member } = row;
  return member;
}
