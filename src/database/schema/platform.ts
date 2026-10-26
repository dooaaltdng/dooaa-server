import type { MediaKind, MediaPurpose, MediaVisibility, NotificationTone, StatScope, SubjectType, SupportStatus } from '../../common/domain';
import { index, table } from '../database';
import type { HomeTile } from './values';

type Timestamps = { createdAt: Date; updatedAt: Date };

/** Named counters handing out increasing numbers. */
export type CounterRow = { id: string; value: number };

export const counters = table<CounterRow>()('counters', { key: 'id', autoId: false, timestamps: false });

/** Dispute numbers ("#3790") and support ticket numbers ("#SUP-1001"). */
export const disputeNumberSeq = { name: 'dispute_number', startWith: 3601 };
export const supportNumberSeq = { name: 'support_number', startWith: 1001 };

/** One document, `id = 'platform'`, holding every settings section as stored by the console. */
export type SettingsRow = Timestamps & {
  id: string;
  values: Record<string, unknown>;
  updatedBy: string | null;
};

export const settings = table<SettingsRow>()('settings', {
  key: 'id',
  autoId: false,
  defaults: () => ({ values: {} }),
  nullable: ['updatedBy'],
});

/** Permissions say who may; this says who did. Written by every destructive console verb. */
export type AuditLogRow = Timestamps & {
  id: string;
  /** The staff member, when a person did it. Kept without a reference: the log outlives accounts. */
  actorId: string | null;
  actorName: string;
  actorRole: string | null;
  action: string;
  target: string;
  targetType: string | null;
  /** An id or a slug, depending on the target type. */
  targetId: string | null;
  /** Marks the superadmin-only verbs, which read differently in a log. */
  elevated: boolean;
  meta: Record<string, unknown> | null;
};

export const auditLog = table<AuditLogRow>()('audit_log', {
  key: 'id',
  defaults: () => ({ elevated: false }),
  nullable: ['actorId', 'actorRole', 'targetType', 'targetId', 'meta'],
  indexes: [
    index('audit_log_created_idx', { createdAt: -1 }),
    index('audit_log_actor_idx', { actorId: 1, createdAt: -1 }),
    index('audit_log_target_idx', { targetType: 1, targetId: 1 }),
  ],
});

/** Every uploaded file. Public files have a permanent URL; private ones are served through signed links. */
export type MediaRow = Timestamps & {
  id: string;
  /** A users.id or staff.id, depending on ownerType. */
  ownerId: string;
  ownerType: SubjectType;
  purpose: MediaPurpose;
  kind: MediaKind;
  name: string;
  mimeType: string;
  /** Bytes. */
  size: number;
  visibility: MediaVisibility;
  storageKey: string;
  url: string | null;
  /** A still frame for videos, used as the chat bubble's poster. */
  posterUrl: string | null;
  /** The storage backend holding the bytes ("cloudinary"). */
  provider: string;
};

export const media = table<MediaRow>()('media', {
  key: 'id',
  nullable: ['url', 'posterUrl'],
  indexes: [
    index('media_storage_key_key', { storageKey: 1 }, { unique: true }),
    index('media_owner_idx', { ownerId: 1, createdAt: -1 }),
    index('media_url_idx', { url: 1 }),
  ],
});

/** The catalog taxonomy. Products reference categories by slug, which is also the route segment. */
export type CategoryRow = Timestamps & {
  slug: string;
  name: string;
  description: string;
  image: string;
  order: number;
  active: boolean;
  /** A category may appear on the landing rail more than once, under different labels. */
  home: HomeTile[];
};

export const categories = table<CategoryRow>()('categories', {
  key: 'slug',
  autoId: false,
  defaults: () => ({ description: '', image: '', order: 0, active: true, home: [] as HomeTile[] }),
  indexes: [index('categories_active_order_idx', { active: 1, order: 1 })],
});

/** A page the console publishes (About Us, Help Center, the four policies). */
export type ContentPageRow = Timestamps & {
  id: string;
  slug: string;
  title: string;
  summary: string;
  /** Sanitised rich text, exactly what the editor saves. */
  body: string;
  updatedBy: string | null;
  order: number;
};

export const contentPages = table<ContentPageRow>()('content_pages', {
  key: 'id',
  defaults: () => ({ summary: '', body: '', order: 0 }),
  nullable: ['updatedBy'],
  indexes: [index('content_pages_slug_key', { slug: 1 }, { unique: true })],
});

/** Every publish keeps the body it replaced, so a page can be restored. */
export type ContentVersionRow = Timestamps & {
  id: string;
  slug: string;
  title: string;
  body: string;
  author: string;
  authorId: string | null;
  note: string;
};

export const contentVersions = table<ContentVersionRow>()('content_versions', {
  key: 'id',
  defaults: () => ({ note: '' }),
  nullable: ['authorId'],
  indexes: [index('content_versions_slug_idx', { slug: 1, createdAt: -1 })],
});

/** "Send us a mail" from the Contact page. */
export type SupportTicketRow = Timestamps & {
  id: string;
  reference: string;
  userId: string | null;
  name: string;
  email: string;
  orderReference: string | null;
  /** One of SUPPORT_TOPICS; kept as text because the topics are display copy. */
  topic: string;
  detail: string;
  attachments: string[];
  status: SupportStatus;
  resolvedAt: Date | null;
  resolvedBy: string | null;
};

export const supportTickets = table<SupportTicketRow>()('support_tickets', {
  key: 'id',
  defaults: () => ({ attachments: [] as string[], status: 'open' as SupportStatus }),
  nullable: ['userId', 'orderReference', 'resolvedAt', 'resolvedBy'],
  indexes: [
    index('support_tickets_reference_key', { reference: 1 }, { unique: true }),
    index('support_tickets_status_idx', { status: 1, createdAt: -1 }),
  ],
});

/** The bell: one document per recipient. Ones older than 120 days are purged by a job. */
export type NotificationRow = Timestamps & {
  id: string;
  /** A users.id or staff.id, depending on recipientType. */
  recipientId: string;
  recipientType: SubjectType;
  /** order.shipped, message.new, dispute.opened, listing.flagged… */
  type: string;
  title: string;
  body: string;
  tone: NotificationTone;
  /** Where tapping it goes, as an app path ("/orders/123-456"). */
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: Date | null;
};

export const notifications = table<NotificationRow>()('notifications', {
  key: 'id',
  defaults: () => ({ body: '', tone: 'blue' as NotificationTone }),
  nullable: ['link', 'data', 'readAt'],
  indexes: [
    index('notifications_recipient_idx', { recipientId: 1, recipientType: 1, createdAt: -1 }),
    index('notifications_unread_idx', { recipientId: 1, readAt: 1 }),
    index('notifications_created_idx', { createdAt: 1 }),
  ],
});

/** Per-day counters (Lagos days). Site rows have no seller. */
export type DailyStatRow = Timestamps & {
  id: string;
  /** YYYY-MM-DD. */
  day: string;
  scope: StatScope;
  sellerId: string | null;
  visits: number;
  productViews: number;
};

export const dailyStats = table<DailyStatRow>()('daily_stats', {
  key: 'id',
  defaults: () => ({ visits: 0, productViews: 0 }),
  nullable: ['sellerId'],
  indexes: [index('daily_stats_scope_seller_day_key', { scope: 1, sellerId: 1, day: 1 }, { unique: true })],
});

/** Which visitors were already counted on a day, so a visit counts once. Purged after three days. */
export type VisitorDayRow = {
  id: string;
  visitorId: string;
  day: string;
  at: Date;
};

export const visitorDays = table<VisitorDayRow>()('visitor_days', {
  key: 'id',
  timestamps: false,
  defaults: () => ({ at: new Date() }),
  indexes: [index('visitor_days_visitor_day_key', { visitorId: 1, day: 1 }, { unique: true }), index('visitor_days_at_idx', { at: 1 })],
});
