import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DAY } from '../../common/util/dates';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { notifications, otps, providerEvents, sessions, visitorDays } from '../../database/schema';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { SettingsService } from '../settings/settings.service';
import { explain } from '../../common/util/explain-error';

type JobName = 'payments' | 'escrow' | 'housekeeping';

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
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.scheduler.enabled) return;
    this.every('payments', 5 * 60_000);
    this.every('escrow', 10 * 60_000);
    this.every('housekeeping', 60 * 60_000);
    this.logger.log('Background jobs scheduled (payments every 5 min, escrow every 10 min, housekeeping hourly)');
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

  async run(name: JobName): Promise<unknown> {
    if (this.running.has(name)) return { skipped: true };
    this.running.add(name);
    try {
      const result = name === 'payments' ? await this.paymentsJob() : name === 'escrow' ? await this.escrowJob() : await this.housekeepingJob();
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
