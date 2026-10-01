import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { ID_TYPE_LABEL, type BankVerificationMethod, type IdType, type VerificationLevel } from '../../common/domain';
import { longDate } from '../../common/util/dates';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { MediaService } from '../media/media.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { Verification } from './verification.schema';

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
  status: Verification['status'];
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
    @InjectModel(Verification.name) private readonly verifications: Model<Verification>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly users: UsersService,
    private readonly media: MediaService,
    private readonly methods: PaymentMethodsService,
    private readonly products: ProductsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  private view(row: Lean<Verification>): VerificationView {
    return {
      id: String(row._id),
      status: row.status,
      idType: row.idType,
      idTypeLabel: ID_TYPE_LABEL[row.idType],
      submittedAt: new Date(row.submittedAt).toISOString(),
      reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null,
      rejectionReason: row.rejectionReason ?? null,
      bank: row.bank ? { method: row.bank.method, bankName: row.bank.bankName, last4: row.bank.last4, accountName: row.bank.accountName } : null,
    };
  }

  /** Where the account's identity check stands. */
  async mine(user: AuthUser): Promise<{ identity: User['identity']; verificationLevel: VerificationLevel; latest: VerificationView | null }> {
    const [record, latest] = await Promise.all([
      this.users.getById(user.id),
      this.verifications.findOne({ userId: new Types.ObjectId(user.id) }).sort({ createdAt: -1 }).lean<Lean<Verification>>(),
    ]);
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

    let bank: Verification['bank'];
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
        payoutAccountId: new Types.ObjectId(account.id),
      };
    }

    const now = new Date();
    const created = await this.verifications.create({
      userId: new Types.ObjectId(user.id),
      status: 'pending',
      idType: input.idType,
      documents: [
        { kind: 'id-front', mediaId: new Types.ObjectId(input.documents.idFront), uploadedAt: now },
        ...(input.documents.idBack ? [{ kind: 'id-back' as const, mediaId: new Types.ObjectId(input.documents.idBack), uploadedAt: now }] : []),
        { kind: 'selfie', mediaId: new Types.ObjectId(input.documents.selfie), uploadedAt: now },
      ],
      livenessPassed: true,
      bank,
      consents: input.consents,
      submittedAt: now,
    });
    await this.users.update(user.id, { $set: { identity: 'pending' } });

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
    return { identity: 'pending', verification: this.view(created.toObject() as Lean<Verification>) };
  }

  /* --- Console ----------------------------------------------------------------- */

  async list(query: { status?: Verification['status']; page?: number; limit?: number }): Promise<Page<VerificationView & { userId: string; name: string; email: string; role: User['role'] }>> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    const total = await this.verifications.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.verifications.find(filter).sort({ submittedAt: -1 }).skip(window.skip).limit(window.size).lean<Lean<Verification>[]>();
    const people = await this.userModel.find({ _id: { $in: rows.map((row) => row.userId) } }).select('firstName lastName email role').lean();
    const byId = new Map(people.map((person) => [String(person._id), person]));
    return toPage(
      rows.map((row) => {
        const person = byId.get(String(row.userId));
        return {
          ...this.view(row),
          userId: String(row.userId),
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
  async documentsFor(row: Lean<Verification>): Promise<KycDocumentView[]> {
    const label: Record<string, string> = {
      'id-front': `ID Document (${ID_TYPE_LABEL[row.idType]})`,
      'id-back': `ID Document — back (${ID_TYPE_LABEL[row.idType]})`,
      selfie: 'Selfie Verification',
    };
    return row.documents.map((document) => ({
      id: String(document.mediaId),
      kind: document.kind,
      label: label[document.kind],
      caption: `${document.kind === 'selfie' ? 'Completed' : 'Uploaded'}: ${longDate(document.uploadedAt)}`,
      action: document.kind === 'selfie' ? 'View Photo' : 'View Document',
      asset: this.media.signedUrl(String(document.mediaId)),
    }));
  }

  async latestFor(userId: string, status?: Verification['status']): Promise<Lean<Verification> | null> {
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (status) filter.status = status;
    return this.verifications.findOne(filter).sort({ createdAt: -1 }).lean<Lean<Verification>>();
  }

  async get(id: string) {
    const row = Types.ObjectId.isValid(id) ? await this.verifications.findById(id).lean<Lean<Verification>>() : null;
    if (!row) throw Errors.notFound('That verification does not exist.', 'VERIFICATION_NOT_FOUND');
    const person = await this.userModel.findById(row.userId).select('firstName lastName email phone role').lean();
    return {
      ...this.view(row),
      userId: String(row.userId),
      name: person ? `${person.firstName} ${person.lastName}` : 'Unknown',
      email: person?.email ?? '',
      role: person?.role ?? null,
      documents: await this.documentsFor(row),
      consents: row.consents,
    };
  }

  async approve(staff: AuthStaff, id: string, level?: VerificationLevel) {
    const row = await this.verifications
      .findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'approved', reviewedBy: staff.id, reviewedAt: new Date() } }, { returnDocument: 'after' })
      .lean<Lean<Verification>>();
    if (!row) throw Errors.conflict('This verification is not waiting for review.', 'VERIFICATION_NOT_PENDING');
    const user = await this.users.update(String(row.userId), { $set: { identity: 'verified', ...(level ? { verificationLevel: level } : {}) } });
    await this.products.syncSellerVerified(String(row.userId), true);
    await this.audit.record(staff, { action: 'Approved an identity verification', target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: String(row.userId) });
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
    const row = await this.verifications
      .findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'rejected', reviewedBy: staff.id, reviewedAt: new Date(), rejectionReason: reason } }, { returnDocument: 'after' })
      .lean<Lean<Verification>>();
    if (!row) throw Errors.conflict('This verification is not waiting for review.', 'VERIFICATION_NOT_PENDING');
    const user = await this.users.update(String(row.userId), { $set: { identity: 'rejected' } });
    await this.audit.record(staff, { action: 'Rejected an identity verification', target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: String(row.userId), meta: { reason } });
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
    const user = await this.users.update(userId, { $set: { verificationLevel: level } });
    await this.audit.record(staff, { action: `Set seller verification to ${level === 'high-value' ? 'High-Value' : 'Normal'}`, target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: userId });
    return { id: userId, verificationLevel: level };
  }
}
