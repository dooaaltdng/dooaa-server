import { Inject } from '@nestjs/common';
import type {
  AggregateOptions,
  ClientSession,
  Collection,
  Db,
  Document,
  Filter,
  IndexDescription,
  MongoClient,
  Sort,
  UpdateFilter,
} from 'mongodb';
import { uuidv7 } from '../common/util/uuid';

/*
 * The MongoDB layer. Each collection is described by a `Table` (name, key
 * field, insert defaults, indexes) and every read and write goes through
 * `Database`, which maps the table's key field to `_id`, fills defaults and
 * timestamps, and runs inside the current transaction when there is one.
 * Rows come back with the key under its own name (`id`, `slug`, …), never
 * `_id`, so the rest of the app sees the same shapes it always has.
 */

type Timestamps = { createdAt: Date; updatedAt: Date };

/** Fields whose type admits null: an insert may leave them out (they default to null). */
type NullableKeys<Row> = { [K in keyof Row]-?: null extends Row[K] ? K : never }[keyof Row];

/** A reference to one field, for the condition helpers in ./query (`eq(orders.status, 'paid')`). */
export type Column<T = unknown> = { readonly field: string; readonly $type?: T };

type Reserved = 'name' | 'key' | 'autoId' | 'timestamps' | 'defaults' | 'indexes' | '$inferSelect' | '$inferInsert';

export type Columns<Row> = { readonly [K in Exclude<keyof Row & string, Reserved>]-?: Column<Row[K]> };

export type Table<Row extends object = any, Key extends keyof Row & string = any, Optional extends keyof Row = any> = {
  readonly name: string;
  /** The field stored as `_id`. */
  readonly key: Key;
  /** Mint a UUIDv7 for the key when an insert leaves it out. */
  readonly autoId: boolean;
  /** Maintain `createdAt` and `updatedAt`. */
  readonly timestamps: boolean;
  readonly defaults: () => Partial<Row>;
  readonly indexes: IndexDescription[];
  /** Type carriers, mirroring Drizzle's `$inferSelect` / `$inferInsert`. */
  readonly $inferSelect: Row;
  readonly $inferInsert: Omit<Row, Optional> & Partial<Pick<Row, Optional>>;
};

export type RowOf<T extends Table> = T['$inferSelect'];
export type InsertOf<T extends Table> = T['$inferInsert'];

/**
 * Declares a collection. `defaults` fills the fields an insert may leave out;
 * `nullable` lists the fields that default to null, so rows always carry them.
 */
export function table<Row extends object>() {
  return <Key extends keyof Row & string, D extends Partial<Row>>(
    name: string,
    options: {
      key: Key;
      autoId?: boolean;
      timestamps?: boolean;
      defaults?: () => D;
      nullable?: NullableKeys<Row>[];
      indexes?: IndexDescription[];
    },
  ): Table<Row, Key, Extract<Extract<keyof D, keyof Row> | Key | NullableKeys<Row> | 'createdAt' | 'updatedAt', keyof Row>> & Columns<Row> => {
    const base = {
      name,
      key: options.key,
      autoId: options.autoId ?? options.key === ('id' as Key),
      timestamps: options.timestamps ?? true,
      defaults: () => ({
        ...Object.fromEntries((options.nullable ?? []).map((field) => [field, null])),
        ...(options.defaults?.() ?? {}),
      }),
      indexes: options.indexes ?? [],
    };
    // Any other property is a column reference.
    return new Proxy(base, {
      get: (target, property) => (typeof property === 'string' && !(property in target) ? { field: property } : Reflect.get(target, property)),
    }) as never;
  };
}

/** An index declaration, named so duplicate-key errors can be matched by name. */
export function index(name: string, key: Record<string, 1 | -1 | 'text'>, options: Omit<IndexDescription, 'key' | 'name'> = {}): IndexDescription {
  return { name, key, ...options };
}

/** A filter on a table's rows, using the row's field names (the key included). */
export type Where<Row> = Filter<Row>;

/** A plain patch (`$set`) or a MongoDB update document. */
export type Patch<Row> = Partial<Row> | UpdateFilter<Row>;

export type FindOptions<Row> = {
  sort?: Sort | Partial<Record<keyof Row & string, 1 | -1>>;
  skip?: number;
  limit?: number;
  /** Fields to leave out of the returned rows. */
  omit?: (keyof Row & string)[];
};

const isOperatorUpdate = (patch: object) => Object.keys(patch).some((key) => key.startsWith('$'));

/** Renames the table's key to `_id` in a filter, sort or projection, recursing through $and/$or/$nor. */
function toStored(value: unknown, key: string): any {
  if (Array.isArray(value)) return value.map((entry) => toStored(entry, key));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [field, inner] of Object.entries(value)) {
    if (field === key) out._id = inner;
    else if (field === '$and' || field === '$or' || field === '$nor') out[field] = toStored(inner, key);
    else out[field] = inner;
  }
  return out;
}

function fromStored<Row>(doc: Document | null, key: string): Row | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { [key]: _id, ...rest } as Row;
}

/** Fills the fields an update must never leave unset. */
function toUpdate(table: Table, patch: object): UpdateFilter<Document> {
  const update: Record<string, any> = isOperatorUpdate(patch) ? { ...patch } : { $set: { ...patch } };
  if (update.$set) {
    update.$set = toStored(update.$set, table.key);
    delete update.$set._id;
    for (const [field, value] of Object.entries(update.$set)) if (value === undefined) delete update.$set[field];
  }
  if (table.timestamps) update.$set = { ...update.$set, updatedAt: new Date() };
  return update;
}

export class Database {
  constructor(
    readonly client: MongoClient,
    readonly db: Db,
    /** The open transaction this handle runs in, if any. */
    readonly session?: ClientSession,
  ) {}

  /** The raw collection, for anything the helpers below do not cover. */
  collection(table: Table): Collection<Document> {
    return this.db.collection(table.name);
  }

  private prepareInsert(table: Table, values: object): Document {
    const now = new Date();
    const row: Record<string, unknown> = { ...table.defaults(), ...values };
    if (table.autoId && row[table.key] === undefined) row[table.key] = uuidv7();
    if (table.timestamps) {
      row.createdAt ??= now;
      row.updatedAt ??= now;
    }
    for (const [field, value] of Object.entries(row)) if (value === undefined) delete row[field];
    const { [table.key]: id, ...rest } = row;
    return { _id: id, ...rest };
  }

  private projection(table: Table, omit?: string[]): Document | undefined {
    return omit?.length ? Object.fromEntries(omit.map((field) => [field === table.key ? '_id' : field, 0])) : undefined;
  }

  async findOne<T extends Table>(table: T, where: Where<RowOf<T>>, options: FindOptions<RowOf<T>> = {}): Promise<RowOf<T> | null> {
    const doc = await this.collection(table).findOne(toStored(where, table.key), {
      session: this.session,
      sort: toStored(options.sort, table.key),
      skip: options.skip,
      projection: this.projection(table, options.omit),
    });
    return fromStored(doc, table.key);
  }

  async find<T extends Table>(table: T, where: Where<RowOf<T>> = {}, options: FindOptions<RowOf<T>> = {}): Promise<RowOf<T>[]> {
    let cursor = this.collection(table).find(toStored(where, table.key), {
      session: this.session,
      projection: this.projection(table, options.omit),
    });
    if (options.sort) cursor = cursor.sort(toStored(options.sort, table.key));
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map((doc) => fromStored<RowOf<T>>(doc, table.key)!);
  }

  async count<T extends Table>(table: T, where: Where<RowOf<T>> = {}): Promise<number> {
    return this.collection(table).countDocuments(toStored(where, table.key), { session: this.session });
  }

  async exists<T extends Table>(table: T, where: Where<RowOf<T>>): Promise<boolean> {
    const doc = await this.collection(table).findOne(toStored(where, table.key), { session: this.session, projection: { _id: 1 } });
    return !!doc;
  }

  /** Distinct values of one field. */
  async distinct<T extends Table, F extends keyof RowOf<T> & string>(table: T, field: F, where: Where<RowOf<T>> = {}): Promise<RowOf<T>[F][]> {
    return this.collection(table).distinct(field === table.key ? '_id' : field, toStored(where, table.key), { session: this.session }) as never;
  }

  async insert<T extends Table>(table: T, values: InsertOf<T>): Promise<RowOf<T>> {
    const doc = this.prepareInsert(table, values);
    await this.collection(table).insertOne(doc, { session: this.session });
    return fromStored(doc, table.key)!;
  }

  async insertMany<T extends Table>(table: T, values: InsertOf<T>[], options: { ordered?: boolean } = {}): Promise<RowOf<T>[]> {
    if (!values.length) return [];
    const docs = values.map((value) => this.prepareInsert(table, value));
    await this.collection(table).insertMany(docs, { session: this.session, ordered: options.ordered ?? true });
    return docs.map((doc) => fromStored<RowOf<T>>(doc, table.key)!);
  }

  /** Inserts the rows whose key or unique fields are not taken yet; returns how many were inserted. */
  async insertIgnoringDuplicates<T extends Table>(table: T, values: InsertOf<T>[]): Promise<number> {
    if (!values.length) return 0;
    try {
      const result = await this.insertManyRaw(table, values);
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) return (error as { result?: { insertedCount?: number }; insertedCount?: number }).insertedCount ?? 0;
      throw error;
    }
  }

  private async insertManyRaw<T extends Table>(table: T, values: InsertOf<T>[]): Promise<number> {
    const docs = values.map((value) => this.prepareInsert(table, value));
    const result = await this.collection(table).insertMany(docs, { session: this.session, ordered: false });
    return result.insertedCount;
  }

  /** Updates one row and returns it as it is after the update, or null when nothing matched. */
  async update<T extends Table>(table: T, where: Where<RowOf<T>>, patch: Patch<RowOf<T>>, options: { sort?: Sort } = {}): Promise<RowOf<T> | null> {
    const doc = await this.collection(table).findOneAndUpdate(toStored(where, table.key), toUpdate(table, patch), {
      session: this.session,
      returnDocument: 'after',
      sort: toStored(options.sort, table.key),
    });
    return fromStored(doc, table.key);
  }

  /** Updates one row and returns it as it was before the update. */
  async updateReturningBefore<T extends Table>(table: T, where: Where<RowOf<T>>, patch: Patch<RowOf<T>>): Promise<RowOf<T> | null> {
    const doc = await this.collection(table).findOneAndUpdate(toStored(where, table.key), toUpdate(table, patch), {
      session: this.session,
      returnDocument: 'before',
    });
    return fromStored(doc, table.key);
  }

  /** Updates every matching row; returns how many changed. */
  async updateMany<T extends Table>(table: T, where: Where<RowOf<T>>, patch: Patch<RowOf<T>>): Promise<number> {
    const result = await this.collection(table).updateMany(toStored(where, table.key), toUpdate(table, patch), { session: this.session });
    return result.modifiedCount;
  }

  /**
   * Updates the matching row, or inserts one built from the filter's plain
   * fields, `insert` and the table defaults. Returns the row after the write.
   */
  async upsert<T extends Table>(table: T, where: Where<RowOf<T>>, patch: Patch<RowOf<T>>, insert: Partial<RowOf<T>> = {}): Promise<RowOf<T>> {
    const update = toUpdate(table, patch) as Record<string, any>;
    const touched = new Set(
      ['$set', '$inc', '$push', '$addToSet', '$unset', '$pull', '$min', '$max', '$mul'].flatMap((op) => Object.keys(update[op] ?? {}).map((f) => f.split('.')[0])),
    );
    const plainFilter = Object.fromEntries(Object.entries(where as object).filter(([field, value]) => !field.startsWith('$') && (value === null || typeof value !== 'object' || value instanceof Date)));
    const seed = this.prepareInsert(table, { ...plainFilter, ...insert });
    const setOnInsert = Object.fromEntries(Object.entries(seed).filter(([field]) => field !== '_id' && !touched.has(field) && !(field in plainFilter)));
    if (table.autoId && !('_id' in toStored(where, table.key))) setOnInsert._id = seed._id;
    if (Object.keys(setOnInsert).length) update.$setOnInsert = { ...update.$setOnInsert, ...setOnInsert };
    const doc = await this.collection(table).findOneAndUpdate(toStored(where, table.key), update, {
      session: this.session,
      returnDocument: 'after',
      upsert: true,
    });
    return fromStored(doc, table.key)!;
  }

  /** Deletes one row and returns it, or null when nothing matched. */
  async delete<T extends Table>(table: T, where: Where<RowOf<T>>): Promise<RowOf<T> | null> {
    const doc = await this.collection(table).findOneAndDelete(toStored(where, table.key), { session: this.session });
    return fromStored(doc, table.key);
  }

  async deleteMany<T extends Table>(table: T, where: Where<RowOf<T>>): Promise<number> {
    const result = await this.collection(table).deleteMany(toStored(where, table.key), { session: this.session });
    return result.deletedCount;
  }

  /** Runs an aggregation pipeline. Stages see stored documents, so the key field is `_id`. */
  async aggregate<R extends Document = Document>(table: Table, pipeline: Document[], options: AggregateOptions = {}): Promise<R[]> {
    return this.collection(table).aggregate<R>(pipeline, { ...options, session: this.session }).toArray();
  }

  /**
   * Runs `work` in a multi-document transaction (retried on transient
   * errors). Inside a transaction already, it simply joins it.
   */
  async transaction<R>(work: (tx: Database) => Promise<R>): Promise<R> {
    if (this.session?.inTransaction()) return work(this);
    const session = this.client.startSession();
    try {
      let result!: R;
      await session.withTransaction(async () => {
        result = await work(new Database(this.client, this.db, session));
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}

/** The handle `db.transaction(async (tx) => …)` passes to its callback. */
export type Transaction = Database;

/** Either the database or an open transaction — what repository helpers accept. */
export type Executor = Database;

export const DATABASE = Symbol('DATABASE');
export const MONGO_CLIENT = Symbol('MONGO_CLIENT');

/** Injects the database handle (`Database`). */
export const InjectDb = () => Inject(DATABASE);

/* Query helpers shared by the services. */

/** Escapes regex metacharacters so a user's search term is matched literally. */
export function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive "contains" match for a user-supplied search term. */
export function containsText(term: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(term.trim()), $options: 'i' };
}

/** Case-insensitive exact match. */
export function equalsText(value: string): { $regex: string; $options: string } {
  return { $regex: `^${escapeRegex(value.trim())}$`, $options: 'i' };
}

/** True when the error is a duplicate-key error (optionally on one named index). */
export function isUniqueViolation(error: unknown, index?: string): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    const candidate = current as { code?: unknown; errmsg?: unknown; message?: unknown; writeErrors?: { code?: unknown }[]; cause?: unknown };
    const duplicate = candidate.code === 11000 || candidate.code === 11001 || candidate.writeErrors?.some((entry) => entry.code === 11000);
    if (duplicate) {
      if (!index) return true;
      const message = String(candidate.errmsg ?? candidate.message ?? '');
      return message.includes(`index: ${index} `) || message.includes(`index: ${index}\n`) || message.endsWith(`index: ${index}`);
    }
    current = candidate.cause;
  }
  return false;
}

/** The listed fields of a row, in the shape a column-picking select used to return. */
export function pick<Row extends object, K extends keyof Row>(row: Row, fields: readonly K[]): Pick<Row, K> {
  return Object.fromEntries(fields.map((field) => [field, row[field]])) as Pick<Row, K>;
}
