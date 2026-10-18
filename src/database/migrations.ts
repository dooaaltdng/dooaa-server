import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database';

/** Where drizzle-kit writes migrations; shipped with the app. */
export const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

type Journal = { entries: { tag: string; when: number }[] };

/** Applies every migration not yet recorded in the database. Safe to run repeatedly. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** Migrations in the journal that the database has not applied, by tag. */
export async function pendingMigrations(db: Database): Promise<string[]> {
  const journalPath = join(MIGRATIONS_FOLDER, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return [];
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const applied = await db
    .execute<{ created_at: string }>(sql`select created_at from drizzle.__drizzle_migrations`)
    .then((result) => new Set(result.rows.map((row) => Number(row.created_at))))
    .catch(() => new Set<number>());
  return journal.entries.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag);
}
