import type { Types } from 'mongoose';

/** A lean document: the schema's fields plus what Mongo adds. */
export type Lean<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/** Common schema options: timestamps on, no version key. */
export const SCHEMA_OPTIONS = { timestamps: true, versionKey: false } as const;
