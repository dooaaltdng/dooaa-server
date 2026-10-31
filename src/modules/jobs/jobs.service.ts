import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DAY } from '../../common/util/dates';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { conversations, notifications, otps, providerEvents, sessions, users, visitorDays } from '../../database/schema';
import { MailService } from '../mail/mail.service';
import { messageReminderMail } from '../mail/mail.templates';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { SettingsService } from '../settings/settings.service';
import { explain } from '../../common/util/explain-error';

type JobName = 'payments' | 'escrow' | 'housekeeping' | 'reminders';

/** A message unread this long earns its recipient one email; older threads are left alone. */
const REMIND_AFTER_MS = 10 * 60_000;
const REMIND_WITHIN_MS = 24 * 60 * 60_000;
/** At most one reminder per person per conversation per hour, however chatty the thread. */
const REMIND_GAP_MS = 60 * 60_000;

/** How long rows that only matter for a while are kept. */
const RETENTION = {
  notifications: 120 * DAY,
  visitorDays: 3 * DAY,
  providerEvents: 30 * DAY,
};

/**
 * Background work. Every step is a conditional, idempotent transition, so
 * running on several instances at once (or twice in a row) is safe. The
 * housekeeping job deletes what has expired.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly running = new Set<JobName>();

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly registry: SchedulerRegistry,
    private readonly payments: PaymentsService,
    private readonly orders: OrdersService,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.scheduler.enabled) return;
    this.every('payments', 5 * 60_000);
    this.every('escrow', 10 * 60_000);
    this.every('housekeeping', 60 * 60_000);
    this.every('reminders', 60_000);
    this.logger.log('Background jobs scheduled (reminders every minute, payments every 5 min, escrow every 10 min, housekeeping hourly)');
  }

  private every(name: JobName, ms: number): void {
    const handle = setInterval(() => void this.run(name), ms);
    handle.unref?.();
    this.registry.addInterval(`jobs:${name}`, handle);
  }

  /** Lapses unpaid checkouts (after confirming with the provider) and re-runs stuck fulfilment. */
  async paymentsJob(now = new Date()): Promise<{ expired: number; refulfilled: number }> {
    const ttl = (await this.settings.section('commerce')).unpaidOrderTtlMinutes;
    const expired = await this.payments.expireStale(new Date(now.getTime() - ttl * 60_000));
    const refulfilled = await this.payments.retryUnfulfilled();
    return { expired, refulfilled };
  }

  /** Releases funds whose inspection window closed and cancels orders never shipped. */
  async escrowJob(now = new Date()): Promise<{ released: number; cancelled: number }> {
    const released = await this.orders.autoRelease(now);
    const cancelled = await this.orders.cancelOverdue(now);
    return { released, cancelled };
  }

  /** Deletes what has expired: sessions, codes and grants past their expiry, and old activity rows. */
  async housekeepingJob(now = new Date()): Promise<Record<string, number>> {
    const before = (ms: number) => new Date(now.getTime() - ms);
    return {
      sessions: await this.db.deleteMany(sessions, { expiresAt: { $lt: now } }),
      otps: await this.db.deleteMany(otps, { expiresAt: { $lt: now } }),
      notifications: await this.db.deleteMany(notifications, { createdAt: { $lt: before(RETENTION.notifications) } }),
      visitorDays: await this.db.deleteMany(visitorDays, { at: { $lt: before(RETENTION.visitorDays) } }),
      providerEvents: await this.db.deleteMany(providerEvents, { receivedAt: { $lt: before(RETENTION.providerEvents) } }),
    };
  }

  /**
   * Emails a buyer or seller whose newest message has sat unread for 10
   * minutes: once per unanswered message, never for their own message, and
   * never to a closed or suspended account. Claiming the reminder is a
   * conditional update, so two instances never both send it.
   */
  async remindersJob(now = new Date()): Promise<{ sent: number }> {
    const rows = await this.db.find(
      conversations,
      { lastMessageAt: { $lte: new Date(now.getTime() - REMIND_AFTER_MS), $gte: new Date(now.getTime() - REMIND_WITHIN_MS) } },
      { limit: 200 },
    );
    let sent = 0;
    for (const row of rows) {
      const sender = row.lastMessageSenderId;
      if (!row.lastMessageAt || (sender !== row.buyerId && sender !== row.sellerId)) continue;
      const side = sender === row.buyerId ? 'seller' : 'buyer';
      const unread = side === 'seller' ? row.sellerUnread : row.buyerUnread;
      const remindedAt = side === 'seller' ? row.sellerRemindedAt : row.buyerRemindedAt;
      if (unread <= 0 || (remindedAt && (remindedAt >= row.lastMessageAt || now.getTime() - remindedAt.getTime() < REMIND_GAP_MS))) continue;
      const field = side === 'seller' ? 'sellerRemindedAt' : 'buyerRemindedAt';
      const claimed = await this.db.update(conversations, { id: row.id, [field]: remindedAt ?? null }, { $set: { [field]: now } });
      if (!claimed) continue;
      const [recipient, from] = await Promise.all([
        this.db.findOne(users, { id: side === 'seller' ? row.sellerId : row.buyerId }),
        this.db.findOne(users, { id: sender }),
      ]);
      if (!recipient?.email || recipient.status !== 'active' || !from) continue;
      void this.mail.send(
        recipient.email,
        messageReminderMail({
          firstName: recipient.firstName,
          senderName: from.firstName,
          itemTitle: row.subject?.title ?? null,
          // Typed words only: a photo or file reads as a plain "unread message", never as a fake quote.
          preview: (row.lastMessageKind === 'text' || row.lastMessageKind === 'product') && row.lastMessagePreview !== 'Sent an offer' ? row.lastMessagePreview : '',
          url: `${this.config.platformUrl}/messages?c=${row.id}`,
        }),
      );
      sent += 1;
    }
    return { sent };
  }

  async run(name: JobName): Promise<unknown> {
    if (this.running.has(name)) return { skipped: true };
    this.running.add(name);
    try {
      const result =
        name === 'payments'
          ? await this.paymentsJob()
          : name === 'escrow'
            ? await this.escrowJob()
            : name === 'reminders'
              ? await this.remindersJob()
              : await this.housekeepingJob();
      this.logger.debug(`Job ${name}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(explain(`The background task "${name}" failed; it will run again on its next schedule`, error));
      return { error: (error as Error).message };
    } finally {
      this.running.delete(name);
    }
  }

  async runAll() {
    return { payments: await this.run('payments'), escrow: await this.run('escrow'), housekeeping: await this.run('housekeeping') };
  }

  onModuleDestroy(): void {
    for (const name of this.registry.getIntervals()) {
      if (name.startsWith('jobs:')) this.registry.deleteInterval(name);
    }
  }
}
