import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps, timestamptz } from './columns';
import { idType, verificationStatus } from './enums';
import { staff, users } from './identity';
import type { VerificationBank, VerificationDocument } from './values';

/** One run of the five-step identity wizard, reviewed by a person in the console. */
export const verifications = pgTable(
  'verifications',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: verificationStatus().notNull().default('pending'),
    idType: idType().notNull(),
    documents: jsonb().$type<VerificationDocument[]>().notNull().default([]),
    livenessPassed: boolean().notNull(),
    bank: jsonb().$type<VerificationBank>(),
    consents: boolean().array().notNull().default(sql`'{}'::boolean[]`),
    submittedAt: timestamptz().notNull(),
    reviewedBy: uuid().references(() => staff.id, { onDelete: 'set null' }),
    reviewedAt: timestamptz(),
    rejectionReason: text(),
    ...timestamps,
  },
  (t) => [index('verifications_user_idx').on(t.userId, t.createdAt.desc()), index('verifications_status_idx').on(t.status, t.submittedAt.desc())],
);
