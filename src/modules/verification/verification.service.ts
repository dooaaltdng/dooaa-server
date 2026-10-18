import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { ID_TYPE_LABEL, type BankVerificationMethod, type IdentityStatus, type IdType, type UserRole, type VerificationLevel, type VerificationStatus } from '../../common/domain';
import { longDate } from '../../common/util/dates';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { users, verifications, type VerificationBank } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

export type Verification = typeof verifications.$inferSelect;

export type SubmitVerificationInput = {
  idType: IdType;
  documents: { idFront: string; idBack?: string; selfie: string };
  livenessPassed: boolean;
  bank?: { method: BankVerificationMethod; bankCode: string; accountNumber: string };
  consents: boolean[];
};

export type KycDocumentView = { id: string; label: string; caption: string; action: string; asset: string; kind: string };

export type VerificationView = {
  id: string;
  status: VerificationStatus;
  idType: IdType;
  idTypeLabel: string;
  submittedAt: string;
  reviewedAt: string | null;
  rejectionReason: string | null;
  bank: { method: BankVerificationMethod; bankName: string; last4: string; accountName: string } | null;
};

@Injectable()
export class VerificationService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly users: UsersService,
    private readonly media: MediaService,
    private readonly methods: PaymentMethodsService,
    private readonly products: ProductsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  private view(row: Verification): VerificationView {
    return {
      id: row.id,
      status: row.status,
      idType: row.idType,
      idTypeLabel: ID_TYPE_LABEL[row.idType],
      submittedAt: row.submittedAt.toISOString(),
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      rejectionReason: row.rejectionReason,
      bank: row.bank ? { method: row.bank.method, bankName: row.bank.bankName, last4: row.bank.last4, accountName: row.bank.accountName } : null,
    };
  }

  /** Where the account's identity check stands. */
  async mine(user: AuthUser): Promise<{ identity: IdentityStatus; verificationLevel: VerificationLevel; latest: VerificationView | null }> {
    const [record, latest] = await Promise.all([this.users.getById(user.id), this.latestFor(user.id)]);
    return { identity: record.identity, verificationLevel: record.verificationLevel, latest: latest ? this.view(latest) : null };
  }

  /**
   * The wizard's Submit: ID photos, selfie with liveness, the payout bank
   * (confirmed with the bank through the provider) and the three consents.
   * Review is manual, so the account lands as pending.
   */
  async submit(user: AuthUser, input: SubmitVerificationInput): Promise<{ identity: 'pending'; verification: VerificationView }> {
    const record = await this.users.getById(user.id);
    if (record.identity === 'verified') throw Errors.conflict('Your identity is already verified.', 'ALREADY_VERIFIED');
    if (record.identity === 'pending') throw Errors.conflict('Your documents are already being reviewed.', 'VERIFICATION_PENDING');
    if (!input.livenessPassed) throw Errors.badRequest('Complete the selfie and liveness check first.', 'LIVENESS_REQUIRED');
    if (input.consents.length < 3 || input.consents.some((consent) => consent !== true)) {
      throw Errors.badRequest('Agree to each statement before submitting.', 'CONSENT_REQUIRED');
    }
    const ids = [input.documents.idFront, input.documents.selfie, ...(input.documents.idBack ? [input.documents.idBack] : [])];
    await this.media.ownedByIds(ids, { id: user.id, type: 'user' }, 'kyc');

    let bank: VerificationBank | null = null;
    if (input.bank) {
      if (input.bank.method === 'micro') {
        throw Errors.badRequest('Micro-deposits are not available for Nigerian banks. Link your bank instantly instead.', 'MICRO_DEPOSITS_UNAVAILABLE');
      }
      // The bank confirms the account holder's name; the reviewer compares it with the ID.
      const account = await this.methods.addPayoutAccount(user.id, { bankCode: input.bank.bankCode, accountNumber: input.bank.accountNumber }, 'verification');
      bank = {
        method: input.bank.method,
        bankName: account.issuer,
        bankCode: input.bank.bankCode,
        last4: account.last4,
        accountName: account.holder,
        payoutAccountId: account.id,
      };
    }

    const now = new Date();
    const uploadedAt = now.toISOString();
    const [created] = await this.db
      .insert(verifications)
      .values({
        userId: user.id,
        status: 'pending',
        idType: input.idType,
        documents: [
          { kind: 'id-front', mediaId: input.documents.idFront, uploadedAt },
          ...(input.documents.idBack ? [{ kind: 'id-back' as const, mediaId: input.documents.idBack, uploadedAt }] : []),
          { kind: 'selfie', mediaId: input.documents.selfie, uploadedAt },
        ],
        livenessPassed: true,
        bank,
        consents: input.consents,
        submittedAt: now,
      })
      .returning();
    await this.users.update(user.id, { identity: 'pending' });

    void this.mail.send(record.email, {
      subject: 'We are reviewing your documents',
      heading: 'Verification submitted',
      paragraphs: [`Thanks, ${record.firstName}. Our team is reviewing your ${ID_TYPE_LABEL[input.idType].toLowerCase()} and selfie.`, 'This usually takes up to 24 hours. We will email you as soon as it is done.'],
    });
    const alerts = await this.settings.section('notifications');
    if (alerts.kycSubmission) {
      await this.notifications.notifyStaff({
        type: 'kyc.submitted',
        title: 'New identity verification',
        body: `${record.firstName} ${record.lastName} submitted documents for review.`,
        tone: 'blue',
        link: `/users/${record.role === 'seller' ? 'sellers' : 'buyers'}/${user.id}`,
      });
    }
    return { identity: 'pending', verification: this.view(created) };
  }

  /* --- Console ----------------------------------------------------------------- */

  async list(query: { status?: VerificationStatus; page?: number; limit?: number }): Promise<Page<VerificationView & { userId: string; name: string; email: string; role: UserRole | null }>> {
    const where = query.status ? eq(verifications.status, query.status) : undefined;
    const [{ total }] = await this.db.select({ total: count() }).from(verifications).where(where);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db.select().from(verifications).where(where).orderBy(desc(verifications.submittedAt)).offset(window.skip).limit(window.size);
    const people = rows.length
      ? await this.db
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role })
          .from(users)
          .where(
            inArray(
              users.id,
              rows.map((row) => row.userId),
            ),
          )
      : [];
    const byId = new Map(people.map((person) => [person.id, person]));
    return toPage(
      rows.map((row) => {
        const person = byId.get(row.userId);
        return {
          ...this.view(row),
          userId: row.userId,
          name: person ? `${person.firstName} ${person.lastName}` : 'Unknown',
          email: person?.email ?? '',
          role: person?.role ?? null,
        };
      }),
      total,
      window,
    );
  }

  /** The documents behind a review, as short-lived signed links. */
  async documentsFor(row: Verification): Promise<KycDocumentView[]> {
    const label: Record<string, string> = {
      'id-front': `ID Document (${ID_TYPE_LABEL[row.idType]})`,
      'id-back': `ID Document — back (${ID_TYPE_LABEL[row.idType]})`,
      selfie: 'Selfie Verification',
    };
    return row.documents.map((document) => ({
      id: document.mediaId,
      kind: document.kind,
      label: label[document.kind],
      caption: `${document.kind === 'selfie' ? 'Completed' : 'Uploaded'}: ${longDate(document.uploadedAt)}`,
      action: document.kind === 'selfie' ? 'View Photo' : 'View Document',
      asset: this.media.signedUrl(document.mediaId),
    }));
  }

  async latestFor(userId: string, status?: VerificationStatus): Promise<Verification | null> {
    if (!isUuid(userId)) return null;
    const [row] = await this.db
      .select()
      .from(verifications)
      .where(and(eq(verifications.userId, userId), status ? eq(verifications.status, status) : undefined))
      .orderBy(desc(verifications.createdAt))
      .limit(1);
    return row ?? null;
  }

  async get(id: string) {
    const [row] = isUuid(id) ? await this.db.select().from(verifications).where(eq(verifications.id, id)) : [];
    if (!row) throw Errors.notFound('That verification does not exist.', 'VERIFICATION_NOT_FOUND');
    const person = await this.users.findById(row.userId);
    return {
      ...this.view(row),
      userId: row.userId,
      name: person ? `${person.firstName} ${person.lastName}` : 'Unknown',
      email: person?.email ?? '',
      role: person?.role ?? null,
      documents: await this.documentsFor(row),
      consents: row.consents,
    };
  }

  /** Moves a pending review to its outcome; only one reviewer can decide it. */
  private async decide(id: string, set: Partial<Verification>): Promise<Verification> {
    const [row] = isUuid(id)
      ? await this.db
          .update(verifications)
          .set(set)
          .where(and(eq(verifications.id, id), eq(verifications.status, 'pending')))
          .returning()
      : [];
    if (!row) throw Errors.conflict('This verification is not waiting for review.', 'VERIFICATION_NOT_PENDING');
    return row;
  }

  async approve(staff: AuthStaff, id: string, level?: VerificationLevel) {
    const row = await this.decide(id, { status: 'approved', reviewedBy: staff.id, reviewedAt: new Date() });
    const user = await this.users.update(row.userId, { identity: 'verified', ...(level ? { verificationLevel: level } : {}) });
    await this.products.syncSellerVerified(row.userId, true);
    await this.audit.record(staff, { action: 'Approved an identity verification', target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: row.userId });
    void this.notifications.notifyUser(row.userId, {
      type: 'kyc.approved',
      title: 'You are verified',
      body: 'Your identity has been confirmed. Buyers will now see the verified badge on your profile.',
      tone: 'green',
      link: '/verification',
      email: { subject: 'Your DOOAA identity is verified', heading: 'You are verified', paragraphs: [`Great news, ${user.firstName} — your identity has been confirmed.`, 'Buyers now see the verified badge on your listings and in chat.'] },
    });
    return this.get(id);
  }

  async reject(staff: AuthStaff, id: string, reason: string) {
    const row = await this.decide(id, { status: 'rejected', reviewedBy: staff.id, reviewedAt: new Date(), rejectionReason: reason });
    const user = await this.users.update(row.userId, { identity: 'rejected' });
    await this.audit.record(staff, { action: 'Rejected an identity verification', target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: row.userId, meta: { reason } });
    void this.notifications.notifyUser(row.userId, {
      type: 'kyc.rejected',
      title: 'Verification needs another try',
      body: reason,
      tone: 'red',
      link: '/verification',
      email: {
        subject: 'We could not verify your identity',
        heading: 'Please try again',
        paragraphs: [`Hi ${user.firstName}, we could not confirm your identity from the documents you sent.`, `Reason: ${reason}`, 'You can submit new documents from the verification page.'],
      },
    });
    return this.get(id);
  }

  async setLevel(staff: AuthStaff, userId: string, level: VerificationLevel) {
    const user = await this.users.update(userId, { verificationLevel: level });
    await this.audit.record(staff, { action: `Set seller verification to ${level === 'high-value' ? 'High-Value' : 'Normal'}`, target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: userId });
    return { id: userId, verificationLevel: level };
  }
}
