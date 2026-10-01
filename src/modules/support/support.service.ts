import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { CountersService } from '../../database/counters.service';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { MediaService } from '../media/media.service';
import { SupportTicket } from './support.schema';

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
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
};

@Injectable()
export class SupportService {
  constructor(
    @InjectModel(SupportTicket.name) private readonly tickets: Model<SupportTicket>,
    private readonly counters: CountersService,
    private readonly mail: MailService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private view(row: Lean<SupportTicket>): TicketView {
    return {
      id: String(row._id),
      reference: row.reference,
      name: row.name,
      email: row.email,
      orderReference: row.orderReference ?? null,
      topic: row.topic,
      detail: row.detail,
      attachments: row.attachments,
      status: row.status,
      createdAt: new Date(row.createdAt).toISOString(),
      resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
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
    const reference = `#SUP-${await this.counters.next('support', 1000)}`;
    const created = await this.tickets.create({
      reference,
      userId: user ? new Types.ObjectId(user.id) : undefined,
      name,
      email,
      orderReference: input.orderId?.trim() || undefined,
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
    return this.view(created.toObject() as Lean<SupportTicket>);
  }

  async list(query: { status?: 'open' | 'resolved'; page?: number; limit?: number }): Promise<Page<TicketView>> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    const total = await this.tickets.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.tickets.find(filter).sort({ createdAt: -1 }).skip(window.skip).limit(window.size).lean<Lean<SupportTicket>[]>();
    return toPage(rows.map((row) => this.view(row)), total, window);
  }

  async setStatus(staff: AuthStaff, id: string, status: 'open' | 'resolved'): Promise<TicketView> {
    const updated = await this.tickets
      .findByIdAndUpdate(id, status === 'resolved' ? { $set: { status, resolvedAt: new Date(), resolvedBy: staff.id } } : { $set: { status }, $unset: { resolvedAt: 1, resolvedBy: 1 } }, { returnDocument: 'after' })
      .lean<Lean<SupportTicket>>();
    if (!updated) throw Errors.notFound('That ticket does not exist.', 'TICKET_NOT_FOUND');
    await this.audit.record(staff, { action: status === 'resolved' ? 'Resolved a support ticket' : 'Reopened a support ticket', target: updated.reference, targetType: 'support', targetId: id });
    return this.view(updated);
  }
}
