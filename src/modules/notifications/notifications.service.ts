import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefKey } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { MailService } from '../mail/mail.service';
import type { MailContent } from '../mail/mail.templates';
import { RealtimeService } from '../realtime/realtime.service';
import { SERVER_EVENTS } from '../realtime/realtime.events';
import { SmsService } from '../sms/sms.service';
import { Staff } from '../staff/schemas/staff.schema';
import { User } from '../users/schemas/user.schema';
import { Notification, type NotificationTone } from './notification.schema';

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

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Staff.name) private readonly staff: Model<Staff>,
    private readonly realtime: RealtimeService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
  ) {}

  private view(row: Lean<Notification>): NotificationView {
    return {
      id: String(row._id),
      type: row.type,
      title: row.title,
      body: row.body,
      tone: row.tone,
      link: row.link ?? null,
      data: row.data ?? null,
      at: new Date(row.createdAt).toISOString(),
      read: Boolean(row.readAt),
    };
  }

  /** In the bell, live over the socket, and by email/SMS where the user wants it. */
  async notifyUser(userId: string | Types.ObjectId, input: NotifyInput): Promise<NotificationView | null> {
    const user = await this.users.findById(userId).select('email phone status notificationPrefs firstName').lean<Lean<User>>();
    if (!user || user.status === 'closed') return null;
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...(user.notificationPrefs ?? {}) };
    const category = input.category ?? 'transactional';

    const created = await this.notifications.create({
      recipientId: user._id,
      recipientType: 'user',
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      tone: input.tone ?? 'blue',
      link: input.link,
      data: input.data,
    });
    const view = this.view(created.toObject() as Lean<Notification>);
    if (prefs.web) this.realtime.toUser(String(user._id), SERVER_EVENTS.notification, view);

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
    const members = await this.staff.find({ status: 'active' }).select('_id email').lean();
    if (!members.length) return;
    const rows = await this.notifications.insertMany(
      members.map((member) => ({
        recipientId: member._id,
        recipientType: 'staff',
        type: input.type,
        title: input.title,
        body: input.body ?? '',
        tone: input.tone ?? 'blue',
        link: input.link,
        data: input.data,
      })),
    );
    for (const row of rows) this.realtime.toStaffMember(String(row.recipientId), SERVER_EVENTS.notification, this.view(row.toObject() as Lean<Notification>));
    if (input.email) for (const member of members) void this.mail.send(member.email, input.email);
  }

  async list(recipient: { id: string; type: 'user' | 'staff' }, query: { unread?: boolean; page?: number; limit?: number }): Promise<Page<NotificationView> & { unread: number }> {
    const filter: Record<string, unknown> = { recipientId: new Types.ObjectId(recipient.id), recipientType: recipient.type };
    if (query.unread) filter.readAt = null;
    const [total, unread] = await Promise.all([
      this.notifications.countDocuments(filter),
      this.unreadCount(recipient),
    ]);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.notifications.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Notification>[]>();
    return { ...toPage(rows.map((row) => this.view(row)), total, window), unread };
  }

  unreadCount(recipient: { id: string; type: 'user' | 'staff' }): Promise<number> {
    return this.notifications.countDocuments({ recipientId: new Types.ObjectId(recipient.id), recipientType: recipient.type, readAt: null });
  }

  async markRead(recipient: { id: string; type: 'user' | 'staff' }, id: string): Promise<NotificationView> {
    const row = await this.notifications
      .findOneAndUpdate(
        { _id: id, recipientId: new Types.ObjectId(recipient.id), recipientType: recipient.type },
        { $set: { readAt: new Date() } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Notification>>();
    if (!row) throw Errors.notFound('That notification is gone.', 'NOTIFICATION_NOT_FOUND');
    return this.view(row);
  }

  async markAllRead(recipient: { id: string; type: 'user' | 'staff' }): Promise<{ updated: number }> {
    const result = await this.notifications.updateMany(
      { recipientId: new Types.ObjectId(recipient.id), recipientType: recipient.type, readAt: null },
      { $set: { readAt: new Date() } },
    );
    return { updated: result.modifiedCount };
  }
}
