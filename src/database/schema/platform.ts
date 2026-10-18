import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgSequence, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps, timestamptz } from './columns';
import { mediaKind, mediaPurpose, mediaVisibility, notificationTone, statScope, subjectType, supportStatus } from './enums';
import { users } from './identity';
import type { HomeTile } from './values';

/** Dispute numbers ("#3790") and support ticket numbers ("#SUP-1001"). */
export const disputeNumberSeq = pgSequence('dispute_number_seq', { startWith: 3601 });
export const supportNumberSeq = pgSequence('support_number_seq', { startWith: 1001 });

/** One row, `id = 'platform'`, holding every settings section as stored by the console. */
export const settings = pgTable('settings', {
  id: text().primaryKey(),
  values: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text(),
  ...timestamps,
});

/** Permissions say who may; this says who did. Written by every destructive console verb. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    /** The staff member, when a person did it. Kept without a foreign key: the log outlives accounts. */
    actorId: uuid(),
    actorName: text().notNull(),
    actorRole: text(),
    action: text().notNull(),
    target: text().notNull(),
    targetType: text(),
    /** An id or a slug, depending on the target type. */
    targetId: text(),
    /** Marks the superadmin-only verbs, which read differently in a log. */
    elevated: boolean().notNull().default(false),
    meta: jsonb().$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt.desc()),
    index('audit_log_actor_idx').on(t.actorId, t.createdAt.desc()),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
  ],
);

/** Every uploaded file. Public files have a permanent URL; private ones are served through signed links. */
export const media = pgTable(
  'media',
  {
    id: primaryId(),
    /** A users.id or staff.id, depending on owner_type. */
    ownerId: uuid().notNull(),
    ownerType: subjectType().notNull(),
    purpose: mediaPurpose().notNull(),
    kind: mediaKind().notNull(),
    name: text().notNull(),
    mimeType: text().notNull(),
    /** Bytes. */
    size: integer().notNull(),
    visibility: mediaVisibility().notNull(),
    storageKey: text().notNull(),
    url: text(),
    /** A still frame for videos, used as the chat bubble's poster. */
    posterUrl: text(),
    /** The storage backend holding the bytes ("cloudinary"). */
    provider: text().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('media_storage_key_key').on(t.storageKey),
    index('media_owner_idx').on(t.ownerId, t.createdAt.desc()),
    index('media_url_idx').on(t.url),
  ],
);

/** The catalog taxonomy. Products reference categories by slug, which is also the route segment. */
export const categories = pgTable(
  'categories',
  {
    slug: text().primaryKey(),
    name: text().notNull(),
    description: text().notNull().default(''),
    image: text().notNull().default(''),
    order: integer('sort_order').notNull().default(0),
    active: boolean().notNull().default(true),
    /** A category may appear on the landing rail more than once, under different labels. */
    home: jsonb().$type<HomeTile[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [index('categories_active_order_idx').on(t.active, t.order)],
);

/** A page the console publishes (About Us, Help Center, the four policies). */
export const contentPages = pgTable(
  'content_pages',
  {
    id: primaryId(),
    slug: text().notNull(),
    title: text().notNull(),
    summary: text().notNull().default(''),
    /** Sanitised rich text, exactly what the editor saves. */
    body: text().notNull().default(''),
    updatedBy: text(),
    order: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [unique('content_pages_slug_key').on(t.slug)],
);

/** Every publish keeps the body it replaced, so a page can be restored. */
export const contentVersions = pgTable(
  'content_versions',
  {
    id: primaryId(),
    slug: text()
      .notNull()
      .references(() => contentPages.slug, { onDelete: 'cascade', onUpdate: 'cascade' }),
    title: text().notNull(),
    body: text().notNull(),
    author: text().notNull(),
    authorId: uuid(),
    note: text().notNull().default(''),
    ...timestamps,
  },
  (t) => [index('content_versions_slug_idx').on(t.slug, t.createdAt.desc())],
);

/** "Send us a mail" from the Contact page. */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: primaryId(),
    reference: text().notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    name: text().notNull(),
    email: text().notNull(),
    orderReference: text(),
    /** One of SUPPORT_TOPICS; kept as text because the topics are display copy. */
    topic: text().notNull(),
    detail: text().notNull(),
    attachments: text().array().notNull().default(sql`'{}'::text[]`),
    status: supportStatus().notNull().default('open'),
    resolvedAt: timestamptz(),
    resolvedBy: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex('support_tickets_reference_key').on(t.reference), index('support_tickets_status_idx').on(t.status, t.createdAt.desc())],
);

/** The bell: one row per recipient. Rows older than 120 days are purged by a job. */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    /** A users.id or staff.id, depending on recipient_type. */
    recipientId: uuid().notNull(),
    recipientType: subjectType().notNull(),
    /** order.shipped, message.new, dispute.opened, listing.flagged… */
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(''),
    tone: notificationTone().notNull().default('blue'),
    /** Where tapping it goes, as an app path ("/orders/123-456"). */
    link: text(),
    data: jsonb().$type<Record<string, unknown>>(),
    readAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    index('notifications_recipient_idx').on(t.recipientId, t.recipientType, t.createdAt.desc()),
    index('notifications_unread_idx').on(t.recipientId, t.readAt),
    index('notifications_created_idx').on(t.createdAt),
  ],
);

/** Per-day counters (Lagos days). Site rows have no seller. */
export const dailyStats = pgTable(
  'daily_stats',
  {
    id: primaryId(),
    day: date({ mode: 'string' }).notNull(),
    scope: statScope().notNull(),
    sellerId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    visits: integer().notNull().default(0),
    productViews: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [unique('daily_stats_scope_seller_day_key').on(t.scope, t.sellerId, t.day).nullsNotDistinct()],
);

/** Which visitors were already counted on a day, so a visit counts once. Purged after three days. */
export const visitorDays = pgTable(
  'visitor_days',
  {
    visitorId: text().notNull(),
    day: date({ mode: 'string' }).notNull(),
    at: timestamptz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.visitorId, t.day] }), index('visitor_days_at_idx').on(t.at)],
);
