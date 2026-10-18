import type { Column } from './database';
import { escapeRegex } from './database';

/*
 * Condition helpers that read like the SQL builders they replace and produce
 * MongoDB filters: `and(eq(orders.status, 'paid'), isNull(orders.disputeId))`.
 * Pass the result to Database.find/findOne/update/count as the filter.
 */

export type Condition = Record<string, any>;

const at = <T>(column: Column<T>, operator: Record<string, unknown> | unknown): Condition => ({ [column.field]: operator });

export const eq = <T>(column: Column<T>, value: T | NonNullable<T>): Condition => at(column, value);
export const ne = <T>(column: Column<T>, value: T | NonNullable<T>): Condition => at(column, { $ne: value });
export const gt = <T>(column: Column<T>, value: NonNullable<T>): Condition => at(column, { $gt: value });
export const gte = <T>(column: Column<T>, value: NonNullable<T>): Condition => at(column, { $gte: value });
export const lt = <T>(column: Column<T>, value: NonNullable<T>): Condition => at(column, { $lt: value });
export const lte = <T>(column: Column<T>, value: NonNullable<T>): Condition => at(column, { $lte: value });
export const isNull = (column: Column): Condition => at(column, null);
export const isNotNull = (column: Column): Condition => at(column, { $ne: null });
export const inArray = <T>(column: Column<T>, values: readonly (T | NonNullable<T>)[]): Condition => at(column, { $in: [...values] });
export const notInArray = <T>(column: Column<T>, values: readonly (T | NonNullable<T>)[]): Condition => at(column, { $nin: [...values] });

/** Case-insensitive "contains" on one field. */
export const contains = (column: Column, term: string): Condition => at(column, { $regex: escapeRegex(term.trim()), $options: 'i' });

export function and(...conditions: (Condition | undefined | null | false)[]): Condition {
  const present = conditions.filter((condition): condition is Condition => !!condition && Object.keys(condition).length > 0);
  if (!present.length) return {};
  return present.length === 1 ? present[0] : { $and: present };
}

export function or(...conditions: (Condition | undefined | null | false)[]): Condition {
  const present = conditions.filter((condition): condition is Condition => !!condition);
  if (!present.length) return { _id: { $in: [] } };
  return present.length === 1 ? present[0] : { $or: present };
}

/** Sort keys, combined in order by Database-backed helpers that accept a list. */
export type SortPart = Record<string, 1 | -1>;
export const asc = (column: Column): SortPart => ({ [column.field]: 1 });
export const desc = (column: Column): SortPart => ({ [column.field]: -1 });
/** MongoDB sorts missing and null values lowest, so a descending sort already puts them last. */
export const descNullsLast = desc;
