import { sql, type AnyColumn, type SQL, type SQLWrapper } from 'drizzle-orm';

/*
 * Small query helpers shared by the services.
 */

/** Escapes LIKE wildcards so a user's search term is matched literally. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Case-insensitive "contains" match for a user-supplied search term. */
export function containsText(column: AnyColumn | SQLWrapper, term: string): SQL {
  return sql`${column} ilike ${`%${escapeLike(term.trim())}%`}`;
}

/** Case-insensitive exact match. */
export function equalsText(column: AnyColumn | SQLWrapper, value: string): SQL {
  return sql`lower(${column}) = ${value.trim().toLowerCase()}`;
}

/** Newest first, with rows that have no value last (the indexes are built this way). */
export function descNullsLast(column: AnyColumn | SQLWrapper): SQL {
  return sql`${column} desc nulls last`;
}

/** Appends entries to a jsonb array column in the same statement as the rest of an update. */
export function appendJson<T>(column: AnyColumn, entries: T[]): SQL {
  return sql`${column} || ${JSON.stringify(entries)}::jsonb`;
}

/** Postgres error codes the API translates. */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  invalidTextRepresentation: '22P02',
} as const;

export type PgErrorInfo = { code: string; constraint?: string; table?: string; detail?: string };

/** The Postgres error behind a failed query, whether thrown by the driver or wrapped by Drizzle. */
export function pgError(error: unknown): PgErrorInfo | null {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; table?: unknown; detail?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        table: typeof candidate.table === 'string' ? candidate.table : undefined,
        detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
      };
    }
    current = candidate.cause;
  }
  return null;
}

/** True when the error is a unique-constraint violation (optionally on one named constraint). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgError(error);
  return info?.code === PG_ERRORS.uniqueViolation && (!constraint || info.constraint === constraint);
}
