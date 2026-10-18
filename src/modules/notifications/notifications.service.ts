import { Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { Errors } from '../../common/api/app-error';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefKey, type NotificationTone, type SubjectType } from '../../common/domain';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { notifications, staff, users } from '../../database/schema';
import { MailService } from '../mail/mail.service';
import type { MailContent } from '../mail/mail.templates';
import { SERVER_EVENTS } from '../realtime/realtime.events';
import { RealtimeService } from '../realtime/realtime.service';
import { SmsService } from '../sms/sms.service';

export type NotifyInput = {
  type: string;
  title: string;
  body?: string;
  tone?: NotificationTone;
  link?: string;
  data?: Record<string, unknown>;
  /**
   * Which preference governs the extras: `transactional` (orders, money,
   * security) always emails; the rest honour the user's switches.
   */
  category?: 'transactional' | NotificationPrefKey;
  email?: MailContent;
  /** Sent only if the user turned SMS notifications on. */
  sms?: string;
};

export type NotificationView = {
  id: string;
  type: string;
  title: string;
  body: string;
  tone: NotificationTone;
  link: string | null;
  data: Record<string, unknown> | null;
  at: string;
  read: boolean;
};

type Recipient = { id: string; type: SubjectType };
type NotificationRow = typeof notifications.$inferSelect;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
  ) {}

  private view(row: NotificationRow): NotificationView {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      tone: row.tone,
      link: row.link,
      data: row.data,
      at: row.createdAt.toISOString(),
      read: Boolean(row.readAt),
    };
  }

  private mine(recipient: Recipient): SQL {
    return and(eq(notifications.recipientId, recipient.id), eq(notifications.recipientType, recipient.type))!;
  }

  /** In the bell, live over the socket, and by email/SMS where the user wants it. */
  async notifyUser(userId: string, input: NotifyInput): Promise<NotificationView | null> {
    if (!isUuid(userId)) return null;
    const [user] = await this.db
      .select({ id: users.id, email: users.email, phone: users.phone, status: users.status, notificationPrefs: users.notificationPrefs })
      .from(users)
      .where(eq(users.id, userId));
    if (!user || user.status === 'closed') return null;
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...user.notificationPrefs };
    const category = input.category ?? 'transactional';

    const [created] = await this.db
      .insert(notifications)
      .values({
        recipientId: user.id,
        recipientType: 'user',
        type: input.type,
        title: input.title,
        body: input.body ?? '',
        tone: input.tone ?? 'blue',
        link: input.link ?? null,
        data: input.data ?? null,
      })
      .returning();
    const view = this.view(created);
    if (prefs.web) this.realtime.toUser(user.id, SERVER_EVENTS.notification, view);

    const wantsEmail = category === 'transactional' || (prefs.email && prefs[category]);
    if (input.email && wantsEmail && user.email) void this.mail.send(user.email, input.email);
    if (input.sms && prefs.sms && user.phone) void this.sms.send(user.phone, input.sms);
    return view;
  }

  async notifyUsers(userIds: string[], input: NotifyInput): Promise<void> {
    for (const id of userIds) {
      await this.notifyUser(id, input).catch((error) => this.logger.warn(`Notify ${id} failed: ${(error as Error).message}`));
    }
  }

  /** Every active console member. */
  async notifyStaff(input: Omit<NotifyInput, 'category' | 'sms'>): Promise<void> {
    const members = await this.db.select({ id: staff.id, email: staff.email }).from(staff).where(eq(staff.status, 'active'));
    if (!members.length) return;
    const rows = await this.db
      .insert(notifications)
      .values(
        members.map((member) => ({
          recipientId: member.id,
          recipientType: 'staff' as const,
          type: input.type,
          title: input.title,
          body: input.body ?? '',
          tone: input.tone ?? 'blue',
          link: input.link ?? null,
          data: input.data ?? null,
        })),
      )
      .returning();
    for (const row of rows) this.realtime.toStaffMember(row.recipientId, SERVER_EVENTS.notification, this.view(row));
    if (input.email) for (const member of members) void this.mail.send(member.email, input.email);
  }

  async list(recipient: Recipient, query: { unread?: boolean; page?: number; limit?: number }): Promise<Page<NotificationView> & { unread: number }> {
    const where = and(this.mine(recipient), query.unread ? isNull(notifications.readAt) : undefined);
    const [[{ total }], unread] = await Promise.all([this.db.select({ total: count() }).from(notifications).where(where), this.unreadCount(recipient)]);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .offset(window.skip)
      .limit(window.size);
    return {
      ...toPage(
        rows.map((row) => this.view(row)),
        total,
        window,
      ),
      unread,
    };
  }

  async unreadCount(recipient: Recipient): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(notifications)
      .where(and(this.mine(recipient), isNull(notifications.readAt)));
    return row.total;
  }

  async markRead(recipient: Recipient, id: string): Promise<NotificationView> {
    const [row] = isUuid(id)
      ? await this.db
          .update(notifications)
          .set({ readAt: new Date() })
          .where(and(eq(notifications.id, id), this.mine(recipient)))
          .returning()
      : [];
    if (!row) throw Errors.notFound('That notification is gone.', 'NOTIFICATION_NOT_FOUND');
    return this.view(row);
  }

  async markAllRead(recipient: Recipient): Promise<{ updated: number }> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(this.mine(recipient), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { updated: updated.length };
  }
}
