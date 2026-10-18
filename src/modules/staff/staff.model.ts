import { getTableColumns } from 'drizzle-orm';
import { staff } from '../../database/schema';

const { passwordHash: _passwordHash, inviteTokenHash: _inviteTokenHash, ...columns } = getTableColumns(staff);

/** Every staff column except the password and invitation hashes — what reads select. */
export const staffColumns = columns;

/** A console account as the services see it. Secrets are never part of it. */
export type StaffMember = Omit<typeof staff.$inferSelect, 'passwordHash' | 'inviteTokenHash'>;
