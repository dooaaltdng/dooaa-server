import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { SupportStatus } from '../../common/domain';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { SequencesService } from '../../database/database.module';
import { supportNumberSeq, supportTickets } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { MediaService } from '../media/media.service';

type TicketRow = typeof supportTickets.$inferSelect;

export type TicketInput = { topic: string; detail: string; orderId?: string; name?: string; email?: string; attachments?: string[] };

export type TicketView = {
  id: string;
  reference: string;
  name: string;
  email: string;
  orderReference: string | null;
  topic: string;
  detail: string;
  attachments: string[];
  status: SupportStatus;
  createdAt: string;
  resolvedAt: string | null;
};

@Injectable()
export class SupportService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly sequences: SequencesService,
    private readonly mail: MailService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private view(row: TicketRow): TicketView {
    return {
      id: row.id,
      reference: row.reference,
      name: row.name,
      email: row.email,
      orderReference: row.orderReference,
      topic: row.topic,
      detail: row.detail,
      attachments: row.attachments,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }

  /** Signed in or not; guests leave a name and an email so we can reply. */
  async create(user: AuthUser | undefined, input: TicketInput): Promise<TicketView> {
    const name = user ? `${user.firstName} ${user.lastName}` : input.name?.trim();
    const email = user ? user.email : input.email?.trim().toLowerCase();
    if (!name || !email) throw Errors.badRequest('Tell us your name and email so we can reply.', 'CONTACT_REQUIRED');
    const attachments = input.attachments ?? [];
    if (attachments.length) {
      if (!user) throw Errors.badRequest('Sign in to attach files.', 'SIGN_IN_TO_ATTACH');
      await this.media.assertOwnedUrls(attachments, { id: user.id, type: 'user' }, ['support', 'evidence', 'message']);
    }
    const reference = `#SUP-${await this.sequences.next(supportNumberSeq)}`;
    const created = await this.db.insert(supportTickets, {
        reference,
        userId: user?.id ?? null,
        name,
        email,
        orderReference: input.orderId?.trim() || null,
        topic: input.topic,
        detail: input.detail,
        attachments,
      });
    void this.mail.send(
      this.config.mail.supportInbox,
      {
        subject: `${reference} · ${input.topic}`,
        heading: `${input.topic} — ${name}`,
        paragraphs: [`From: ${name} <${email}>`, ...(input.orderId ? [`Order: ${input.orderId}`] : []), input.detail, ...attachments.map((url) => `Attachment: ${url}`)],
      },
      { replyTo: email },
    );
    void this.mail.send(email, {
      subject: `We received your message (${reference})`,
      heading: 'Thanks — we have your message',
      paragraphs: [`Hi ${name.split(' ')[0]}, our support team has your message about “${input.topic.toLowerCase()}”.`, 'We usually reply within one business day. Reply to this email to add anything.'],
    });
    return this.view(created);
  }

  async list(query: { status?: SupportStatus; page?: number; limit?: number }): Promise<Page<TicketView>> {
    const where = query.status ? { status: query.status } : {};
    const total = await this.db.count(supportTickets, where);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db.find(supportTickets, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size });
    return toPage(
      rows.map((row) => this.view(row)),
      total,
      window,
    );
  }

  async setStatus(staff: AuthStaff, id: string, status: SupportStatus): Promise<TicketView> {
    if (!isUuid(id)) throw Errors.notFound('That ticket does not exist.', 'TICKET_NOT_FOUND');
    const updated = await this.db.update(
      supportTickets,
      { id },
      status === 'resolved' ? { status, resolvedAt: new Date(), resolvedBy: staff.id } : { status, resolvedAt: null, resolvedBy: null },
    );
    if (!updated) throw Errors.notFound('That ticket does not exist.', 'TICKET_NOT_FOUND');
    await this.audit.record(staff, { action: status === 'resolved' ? 'Resolved a support ticket' : 'Reopened a support ticket', target: updated.reference, targetType: 'support', targetId: id });
    return this.view(updated);
  }
}
