import { Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefKey, type NotificationTone, type SubjectType } from '../../common/domain';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database, type Where } from '../../database/database';
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

  private mine(recipient: Recipient): Where<NotificationRow> {
    return { recipientId: recipient.id, recipientType: recipient.type };
  }

  /** In the bell, live over the socket, and by email/SMS where the user wants it. */
  async notifyUser(userId: string, input: NotifyInput): Promise<NotificationView | null> {
    if (!isUuid(userId)) return null;
    const user = await this.db.findOne(users, { id: userId });
    if (!user || user.status === 'closed') return null;
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...user.notificationPrefs };
    const category = input.category ?? 'transactional';

    const created = await this.db.insert(notifications, {
        recipientId: user.id,
        recipientType: 'user',
        type: input.type,
        title: input.title,
        body: input.body ?? '',
        tone: input.tone ?? 'blue',
        link: input.link ?? null,
        data: input.data ?? null,
      });
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
    const members = await this.db.find(staff, { status: 'active' });
    if (!members.length) return;
    const rows = await this.db.insertMany(
      notifications,
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
    );
    for (const row of rows) this.realtime.toStaffMember(row.recipientId, SERVER_EVENTS.notification, this.view(row));
    if (input.email) for (const member of members) void this.mail.send(member.email, input.email);
  }

  async list(recipient: Recipient, query: { unread?: boolean; page?: number; limit?: number }): Promise<Page<NotificationView> & { unread: number }> {
    const where: Where<NotificationRow> = { ...this.mine(recipient), ...(query.unread ? { readAt: null } : {}) };
    const [total, unread] = await Promise.all([this.db.count(notifications, where), this.unreadCount(recipient)]);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db.find(notifications, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size });
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
    return this.db.count(notifications, { ...this.mine(recipient), readAt: null });
  }

  async markRead(recipient: Recipient, id: string): Promise<NotificationView> {
    const row = isUuid(id) ? await this.db.update(notifications, { id, ...this.mine(recipient) }, { readAt: new Date() }) : null;
    if (!row) throw Errors.notFound('That notification is gone.', 'NOTIFICATION_NOT_FOUND');
    return this.view(row);
  }

  async markAllRead(recipient: Recipient): Promise<{ updated: number }> {
    const updated = await this.db.updateMany(notifications, { ...this.mine(recipient), readAt: null }, { readAt: new Date() });
    return { updated };
  }
}
