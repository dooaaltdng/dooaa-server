/**
 * The MongoDB schema: one `table(…)` declaration per collection, with its row
 * type, insert defaults and indexes (created at startup). Field names are
 * camelCase in both the code and the stored documents.
 */
export * from './identity';
export * from './platform';
export * from './catalog';
export * from './trade';
export * from './money';
export * from './verification';
export type * from './values';
export type { Table, RowOf, InsertOf } from '../database';
