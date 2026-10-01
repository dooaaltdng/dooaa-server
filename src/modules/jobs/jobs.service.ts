import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { SettingsService } from '../settings/settings.service';

type JobName = 'payments' | 'escrow';

/**
 * Background work. Every step is a conditional, idempotent transition, so
 * running on several instances at once (or twice in a row) is safe.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly running = new Set<JobName>();

  constructor(
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
    this.logger.log('Background jobs scheduled (payments every 5 min, escrow every 10 min)');
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

  async run(name: JobName): Promise<unknown> {
    if (this.running.has(name)) return { skipped: true };
    this.running.add(name);
    try {
      const result = name === 'payments' ? await this.paymentsJob() : await this.escrowJob();
      this.logger.debug(`Job ${name}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(`Job ${name} failed: ${(error as Error).message}`);
      return { error: (error as Error).message };
    } finally {
      this.running.delete(name);
    }
  }

  async runAll() {
    return { payments: await this.run('payments'), escrow: await this.run('escrow') };
  }

  onModuleDestroy(): void {
    for (const name of this.registry.getIntervals()) {
      if (name.startsWith('jobs:')) this.registry.deleteInterval(name);
    }
  }
}
