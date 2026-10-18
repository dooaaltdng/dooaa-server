import { customType, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../../common/util/uuid';

/** Primary key: a UUIDv7 minted by the app, so ids sort by creation time. */
export const primaryId = () => uuid().primaryKey().$defaultFn(() => uuidv7());

/**
 * Naira, to the kobo. Read back as a JS number: amounts are stored in major
 * units and every calculation runs in integer kobo (see common/util/money).
 */
export const money = () => numeric({ precision: 14, scale: 2, mode: 'number' });

export const timestamptz = () => timestamp({ withTimezone: true, mode: 'date' });

export const timestamps = {
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Postgres full-text document. Only ever written by a generated column. */
export const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});
