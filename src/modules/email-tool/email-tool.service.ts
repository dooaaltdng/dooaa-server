import { Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { and, contains, eq, inArray, ne, or, type Condition } from '../../database/query';
import { auditLog, users } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { maskEmail, maskName } from './email-tool.mask';

export type EmailMode = 'test' | 'live';
export type EmailTarget = 'one' | 'selected' | 'all';

export type MaskedUser = { id: string; name: string; email: string; role: 'buyer' | 'seller'; joined: string };

/** One line per email sent: what the logs view and the server log show. */
export type EmailLog = {
  id: string;
  at: string;
  actor: string;
  campaign: string;
  mode: EmailMode;
  target: EmailTarget;
  /** Masked address the email went to (the test address in test mode). */
  recipient: string;
  status: 'sent' | 'failed';
  /** How many times this recipient has now been sent this campaign — 1 is the goal. */
  sentCount: number;
};

/** What a send returns: a summary plus its log lines. */
export type EmailSendResult = { campaign: string; mode: EmailMode; audience: number; sent: number; failed: number; lines: EmailLog[] };

type Delivery = { key: string; recipient: string; status: 'sent' | 'failed' };

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const LOG_TYPE = 'email-tool';
const BATCH = 20;
/** The test address is never shown, not even masked. */
const HIDDEN_TEST = 'test address (hidden)';

@Injectable()
export class EmailToolService {
  private readonly logger = new Logger(EmailToolService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @InjectConfig() private readonly config: AppConfig,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  private reachable(): Condition[] {
    return [ne(users.email, OFFICIAL_STORE_EMAIL), ne(users.status, 'closed')];
  }

  async users(query: { search?: string; page?: number; limit?: number }): Promise<Page<MaskedUser>> {
    const conditions = this.reachable();
    for (const word of (query.search?.trim() ?? '').split(/\s+/).filter(Boolean).slice(0, 4)) {
      conditions.push(or(contains(users.firstName, word), contains(users.lastName, word), contains(users.email, word)));
    }
    const where = and(...conditions);
    const total = await this.db.count(users, where);
    const window = pageWindow(total, query.page, query.limit ?? 25);
    const rows = await this.db.find(users, where, { sort: { createdAt: -1 }, skip: window.skip, limit: window.size });
    return toPage(
      rows.map((row) => ({
        id: row.id,
        name: maskName(row.firstName ?? '', row.lastName ?? ''),
        email: maskEmail(row.email),
        role: row.role === 'seller' ? 'seller' : 'buyer',
        joined: row.createdAt.toISOString(),
      })),
      total,
      window,
    );
  }

  /**
   * Sends a campaign. No guard against repeats: sending the same campaign
   * again (a second click, a retry) emails everyone again.
   */
  async send(
    actor: AuthStaff,
    input: { campaign?: string; subject: string; message: string; mode: EmailMode; target: EmailTarget; userIds?: string[] },
  ): Promise<EmailSendResult> {
    const ids = [...new Set(input.userIds ?? [])];
    const live = input.mode === 'live';
    // Test mode only ever emails the test address, so it needs no one picked.
    if (live && input.target === 'one' && ids.length !== 1) throw Errors.badRequest('Pick one person to email.');
    if (live && input.target === 'selected' && ids.length === 0) throw Errors.badRequest('Pick at least one person to email.');
    const campaign = input.campaign?.trim() || input.subject;

    const conditions = this.reachable();
    if (input.target !== 'all') conditions.push(inArray(users.id, ids));
    const recipients = await this.db.find(users, and(...conditions), { sort: { createdAt: -1 } });
    if (live && !recipients.length) throw Errors.badRequest('None of the chosen people can be emailed.');

    const paragraphs = input.message.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const content = (firstName: string) => ({ subject: input.subject, heading: input.subject, paragraphs: firstName ? [`Hi ${firstName},`, ...paragraphs] : paragraphs });
    const status = (ok: boolean) => (ok ? 'sent' : 'failed') as Delivery['status'];

    const deliveries: Delivery[] = [];
    if (input.mode === 'test') {
      // Test mode: one copy, to the test address only, with no greeting name.
      const address = this.config.mail.testAddress;
      const ok = await this.mail.send(address, { ...content(''), subject: `[TEST] ${input.subject}` });
      deliveries.push({ key: `test:${address.toLowerCase()}`, recipient: HIDDEN_TEST, status: status(ok) });
    } else {
      for (let i = 0; i < recipients.length; i += BATCH) {
        const batch = recipients.slice(i, i + BATCH);
        const results = await Promise.all(batch.map((user) => this.mail.send(user.email, content(user.firstName ?? ''))));
        batch.forEach((user, index) => deliveries.push({ key: user.id, recipient: maskEmail(user.email), status: status(results[index]) }));
      }
    }

    const record = await this.audit.record(actor, {
      action: input.mode === 'test' ? 'Sent a test email' : 'Sent an email to users',
      target: campaign,
      targetType: LOG_TYPE,
      elevated: input.mode === 'live' && input.target === 'all',
      meta: { campaign, subject: input.subject, mode: input.mode, target: input.target, deliveries },
    });
    // Counted after saving, so overlapping sends (a double click) each see the other.
    const totals = await this.priorCounts(campaign, input.mode);

    const lines = deliveries.map((delivery, index) => {
      const sentCount = totals.get(delivery.key) ?? 0;
      const line: EmailLog = { id: `${record.id}:${index}`, at: record.at, actor: record.actor, campaign, mode: input.mode, target: input.target, recipient: delivery.recipient, status: delivery.status, sentCount };
      this.logger.log(`email campaign="${campaign}" mode=${line.mode} to=${line.recipient} status=${line.status} sentCount=${line.sentCount}`);
      return line;
    });
    const sent = deliveries.filter((d) => d.status === 'sent').length;
    return { campaign, mode: input.mode, audience: recipients.length, sent, failed: deliveries.length - sent, lines };
  }

  private async priorCounts(campaign: string, mode: EmailMode): Promise<Map<string, number>> {
    const rows = await this.db.find(auditLog, and(eq(auditLog.targetType, LOG_TYPE), eq(auditLog.target, campaign)));
    const counts = new Map<string, number>();
    for (const row of rows) {
      const meta = (row.meta ?? {}) as { mode?: EmailMode; deliveries?: Delivery[] };
      if (meta.mode !== mode) continue;
      for (const d of meta.deliveries ?? []) if (d.status === 'sent') counts.set(d.key, (counts.get(d.key) ?? 0) + 1);
    }
    return counts;
  }

  /** Deletes one log line (`<send id>:<index>`); the send's record goes once its last line does. */
  async deleteLog(lineId: string): Promise<{ id: string }> {
    const [recordId, rawIndex] = lineId.split(':');
    const index = Number(rawIndex);
    const row = await this.db.findOne(auditLog, { id: recordId, targetType: LOG_TYPE });
    if (!row || !Number.isInteger(index)) throw Errors.notFound('That log line no longer exists.');
    const meta = (row.meta ?? {}) as { deliveries?: Delivery[] };
    const deliveries = (meta.deliveries ?? []).filter((_, i) => i !== index);
    if (deliveries.length) await this.db.update(auditLog, { id: recordId }, { meta: { ...meta, deliveries } });
    else await this.db.delete(auditLog, { id: recordId });
    return { id: lineId };
  }

  /** Clears the email tool's log (only its own records, not the rest of the audit log). */
  async clearLogs(): Promise<{ deleted: number }> {
    return { deleted: await this.db.deleteMany(auditLog, { targetType: LOG_TYPE }) };
  }

  /** Every email sent, newest first, one line each. */
  async logs(query: { page?: number; limit?: number }): Promise<Page<EmailLog>> {
    const rows = await this.db.find(auditLog, eq(auditLog.targetType, LOG_TYPE), { sort: { createdAt: 1, id: 1 } });
    const counts = new Map<string, number>();
    const lines: EmailLog[] = [];
    for (const row of rows) {
      const meta = (row.meta ?? {}) as { campaign?: string; mode?: EmailMode; target?: EmailTarget; deliveries?: Delivery[] };
      const campaign = meta.campaign ?? row.target;
      const mode = meta.mode ?? 'test';
      (meta.deliveries ?? []).forEach((d, index) => {
        const key = `${mode}|${campaign}|${d.key}`;
        const sentCount = (counts.get(key) ?? 0) + (d.status === 'sent' ? 1 : 0);
        counts.set(key, sentCount);
        lines.push({ id: `${row.id}:${index}`, at: row.createdAt.toISOString(), actor: row.actorName, campaign, mode, target: meta.target ?? 'one', recipient: d.recipient, status: d.status, sentCount });
      });
    }
    lines.reverse();
    const window = pageWindow(lines.length, query.page, query.limit ?? 20);
    return toPage(lines.slice(window.skip, window.skip + window.size), lines.length, window);
  }
}
