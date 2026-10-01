import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { renderMail, type MailContent } from './mail.templates';

export type SentMail = { to: string; subject: string; html: string; text: string; at: Date; replyTo?: string };

const RETRY_DELAYS_MS = [1_000, 5_000, 20_000];

/**
 * Sends transactional email through nodemailer. Sending never blocks or
 * fails a request: messages go on an in-process queue with retries, and
 * failures are logged. The `memory` transport keeps an outbox for tests;
 * `log` prints instead of sending (local development).
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  /** Messages delivered by the memory/log transports, newest last. */
  readonly outbox: SentMail[] = [];
  private inflight = new Set<Promise<void>>();

  constructor(@InjectConfig() private readonly config: AppConfig) {
    this.transporter =
      config.mail.transport === 'smtp'
        ? nodemailer.createTransport({
            host: config.mail.smtp.host,
            port: config.mail.smtp.port,
            secure: config.mail.smtp.secure,
            auth: config.mail.smtp.user ? { user: config.mail.smtp.user, pass: config.mail.smtp.pass } : undefined,
            pool: true,
            maxConnections: 3,
          })
        : null;
  }

  /** Queues a message and returns a promise that settles when it is delivered or given up on. */
  send(to: string, content: MailContent, options: { replyTo?: string } = {}): Promise<void> {
    const rendered = renderMail(content);
    const job = this.deliver({ to, ...rendered, replyTo: options.replyTo, at: new Date() });
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
    return job;
  }

  /** Resolves once everything queued so far has settled. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async deliver(mail: SentMail): Promise<void> {
    if (this.config.mail.transport !== 'smtp' || !this.transporter) {
      this.outbox.push(mail);
      if (this.outbox.length > 500) this.outbox.shift();
      if (this.config.mail.transport === 'log') this.logger.log(`✉️  ${mail.to} — ${mail.subject}\n${mail.text}`);
      return;
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.transporter.sendMail({
          from: this.config.mail.from,
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          replyTo: mail.replyTo,
        });
        return;
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          this.logger.error(`Giving up on mail to ${mail.to} (${mail.subject}): ${(error as Error).message}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]).unref?.());
      }
    }
  }

  /** Test helper: the most recent message sent to an address. */
  lastTo(address: string): SentMail | undefined {
    const needle = address.toLowerCase();
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      if (this.outbox[index].to.toLowerCase() === needle) return this.outbox[index];
    }
    return undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
    this.transporter?.close();
  }
}
