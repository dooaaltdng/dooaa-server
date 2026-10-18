import { staff } from '../../database/schema';

/** Fields reads leave out: the password and invitation hashes. */
export const staffOmit: ['passwordHash', 'inviteTokenHash'] = ['passwordHash', 'inviteTokenHash'];

/** A console account as the services see it. Secrets are never part of it. */
export type StaffMember = Omit<typeof staff.$inferSelect, 'passwordHash' | 'inviteTokenHash'>;
