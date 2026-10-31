import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { renderMail, type MailContent } from './mail.templates';
import { MAIL_TRANSPORT, type MailTransport } from './mail.transport';
import { explain } from '../../common/util/explain-error';

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];

/**
 * Sends transactional email through nodemailer over SMTP. Sending never
 * blocks or fails a request: messages go on an in-process queue with
 * retries, and failures are logged.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    @InjectConfig() private readonly config: AppConfig,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  /** Queues a message and returns a promise that settles when it is delivered or given up on. */
  send(to: string, content: MailContent, options: { replyTo?: string } = {}): Promise<void> {
    const rendered = renderMail(content);
    const job = this.deliver({ from: this.config.mail.from, to, ...rendered, replyTo: options.replyTo ?? this.config.mail.supportInbox });
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
    return job;
  }

  /** Resolves once everything queued so far has settled. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async deliver(mail: { from: string; to: string; subject: string; html: string; text: string; replyTo?: string }): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.transport.sendMail(mail);
        return;
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          this.logger.error(explain(`Could not send the email "${mail.subject}" to ${mail.to} after several tries, so it was dropped`, error));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]).unref?.());
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
    this.transport.close();
  }
}
