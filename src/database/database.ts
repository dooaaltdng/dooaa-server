import { Inject } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** The handle `db.transaction(async (tx) => …)` passes to its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either the database or an open transaction — what repository helpers accept. */
export type Executor = Database | Transaction;

export const DATABASE = Symbol('DATABASE');
export const PG_POOL = Symbol('PG_POOL');

/** Injects the Drizzle client (`Database`). */
export const InjectDb = () => Inject(DATABASE);
