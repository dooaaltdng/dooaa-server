import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { TtlCache } from '../../common/util/cache';
import type { Lean } from '../../common/util/mongo';
import { PAYMENT_PROVIDER, type Bank, type CardAuthorization, type PaymentProvider } from './providers/payment-provider';
import { PayoutAccount } from './schemas/payout-account.schema';
import { SavedCard } from './schemas/saved-card.schema';

/** One row of the settings panel's "Payment accounts" (banks to be paid into, cards to pay with). */
export type PaymentAccountView = {
  id: string;
  type: 'bank' | 'card';
  /** Bank name, or the card network for cards. */
  issuer: string;
  holder: string;
  last4: string;
  verified: boolean;
  primary: boolean;
  bankCode?: string;
  expiry?: string;
};

const BRAND_LABEL: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Master Card',
  verve: 'Verve',
  'american express': 'American Express',
  amex: 'American Express',
};

function fingerprint(bankCode: string, accountNumber: string): string {
  return createHash('sha256').update(`${bankCode}:${accountNumber}`).digest('hex');
}

@Injectable()
export class PaymentMethodsService {
  private readonly banksCache = new TtlCache<Bank[]>(60 * 60_000, 1);

  constructor(
    @InjectModel(SavedCard.name) private readonly cards: Model<SavedCard>,
    @InjectModel(PayoutAccount.name) private readonly accounts: Model<PayoutAccount>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /* --- Banks ---------------------------------------------------------------- */

  listBanks(): Promise<Bank[]> {
    return this.banksCache.wrap('banks', () => this.provider.listBanks());
  }

  async bankName(code: string): Promise<string> {
    const bank = (await this.listBanks()).find((entry) => entry.code === code);
    if (!bank) throw Errors.badRequest('Choose a bank from the list.', 'UNKNOWN_BANK');
    return bank.name;
  }

  /** "Link Bank Instantly": the bank confirms the account holder's name. */
  async resolveAccount(accountNumber: string, bankCode: string) {
    const bankName = await this.bankName(bankCode);
    const resolved = await this.provider.resolveAccount(accountNumber, bankCode);
    return { ...resolved, bankName };
  }

  /* --- Payout accounts ------------------------------------------------------ */

  private accountView(row: Lean<PayoutAccount>): PaymentAccountView {
    return {
      id: String(row._id),
      type: 'bank',
      issuer: row.bankName,
      holder: row.accountName,
      last4: row.last4,
      verified: row.verified,
      primary: row.primary,
      bankCode: row.bankCode,
    };
  }

  async addPayoutAccount(
    userId: string,
    input: { bankCode: string; accountNumber: string; primary?: boolean },
    source: 'settings' | 'verification' = 'settings',
  ): Promise<PaymentAccountView> {
    const resolved = await this.resolveAccount(input.accountNumber, input.bankCode);
    const { recipientCode } = await this.provider.createTransferRecipient({
      name: resolved.accountName,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
    });
    const owner = new Types.ObjectId(userId);
    const hasAny = (await this.accounts.countDocuments({ userId: owner })) > 0;
    const primary = input.primary === true || !hasAny;
    if (primary) await this.accounts.updateMany({ userId: owner }, { $set: { primary: false } });
    const row = await this.accounts
      .findOneAndUpdate(
        { userId: owner, fingerprint: fingerprint(input.bankCode, input.accountNumber) },
        {
          $set: {
            provider: this.provider.name,
            bankCode: input.bankCode,
            bankName: resolved.bankName,
            accountName: resolved.accountName,
            last4: input.accountNumber.slice(-4),
            recipientCode,
            verified: true,
            source,
            ...(primary ? { primary: true } : {}),
          },
          $setOnInsert: primary ? {} : { primary: false },
        },
        { upsert: true, returnDocument: 'after' },
      )
      .lean<Lean<PayoutAccount>>();
    return this.accountView(row!);
  }

  async payoutAccounts(userId: string): Promise<PaymentAccountView[]> {
    const rows = await this.accounts.find({ userId: new Types.ObjectId(userId) }).sort({ primary: -1, createdAt: 1 }).lean<Lean<PayoutAccount>[]>();
    return rows.map((row) => this.accountView(row));
  }

  async payoutAccount(userId: string, id?: string): Promise<Lean<PayoutAccount> | null> {
    const owner = new Types.ObjectId(userId);
    if (id) {
      if (!Types.ObjectId.isValid(id)) return null;
      return this.accounts.findOne({ _id: id, userId: owner }).lean<Lean<PayoutAccount>>();
    }
    return this.accounts.findOne({ userId: owner }).sort({ primary: -1, createdAt: 1 }).lean<Lean<PayoutAccount>>();
  }

  /* --- Saved cards ---------------------------------------------------------- */

  private cardView(row: Lean<SavedCard>, holder: string): PaymentAccountView {
    const brand = (row.brand ?? '').toLowerCase();
    return {
      id: String(row._id),
      type: 'card',
      issuer: BRAND_LABEL[brand] ?? (row.brand ? row.brand[0].toUpperCase() + row.brand.slice(1) : 'Card'),
      holder,
      last4: row.last4 ?? '',
      verified: true,
      primary: row.primary,
      expiry: row.expMonth && row.expYear ? `${row.expMonth.padStart(2, '0')}/${row.expYear.slice(-2)}` : undefined,
    };
  }

  /** Called when the provider confirms a reusable card payment. */
  async saveCard(userId: string, provider: string, authorization: CardAuthorization): Promise<void> {
    const owner = new Types.ObjectId(userId);
    const hasAny = (await this.cards.countDocuments({ userId: owner })) > 0;
    const key = authorization.signature ? { userId: owner, signature: authorization.signature } : { userId: owner, authorizationCode: authorization.authorizationCode };
    await this.cards.updateOne(
      key,
      {
        $set: {
          provider,
          authorizationCode: authorization.authorizationCode,
          last4: authorization.last4,
          brand: authorization.brand,
          bank: authorization.bank,
          expMonth: authorization.expMonth,
          expYear: authorization.expYear,
        },
        $setOnInsert: { primary: !hasAny },
      },
      { upsert: true },
    );
  }

  async savedCards(userId: string, holder: string): Promise<PaymentAccountView[]> {
    const rows = await this.cards.find({ userId: new Types.ObjectId(userId) }).sort({ primary: -1, createdAt: 1 }).lean<Lean<SavedCard>[]>();
    return rows.map((row) => this.cardView(row, holder));
  }

  async authorizationFor(userId: string, cardId: string): Promise<string> {
    if (!Types.ObjectId.isValid(cardId)) throw Errors.notFound('That saved card is no longer available.', 'CARD_NOT_FOUND');
    const card = await this.cards.findOne({ _id: cardId, userId: new Types.ObjectId(userId) }).select('+authorizationCode').lean();
    if (!card) throw Errors.notFound('That saved card is no longer available.', 'CARD_NOT_FOUND');
    return card.authorizationCode;
  }

  /* --- Both, as the settings panel shows them ------------------------------- */

  async accountsFor(userId: string, holder: string): Promise<PaymentAccountView[]> {
    const [banks, cards] = await Promise.all([this.payoutAccounts(userId), this.savedCards(userId, holder)]);
    return [...banks, ...cards];
  }

  async remove(userId: string, id: string): Promise<{ removed: true }> {
    if (!Types.ObjectId.isValid(id)) throw Errors.notFound('That payment account is not on your profile.', 'ACCOUNT_NOT_FOUND');
    const owner = new Types.ObjectId(userId);
    const bank = await this.accounts.findOneAndDelete({ _id: id, userId: owner }).lean<Lean<PayoutAccount>>();
    if (bank) {
      if (bank.primary) await this.promoteNext('bank', owner);
      return { removed: true };
    }
    const card = await this.cards.findOneAndDelete({ _id: id, userId: owner }).lean<Lean<SavedCard>>();
    if (card) {
      if (card.primary) await this.promoteNext('card', owner);
      return { removed: true };
    }
    throw Errors.notFound('That payment account is not on your profile.', 'ACCOUNT_NOT_FOUND');
  }

  private async promoteNext(kind: 'bank' | 'card', owner: Types.ObjectId): Promise<void> {
    if (kind === 'bank') {
      const next = await this.accounts.findOne({ userId: owner }).sort({ createdAt: 1 }).lean();
      if (next) await this.accounts.updateOne({ _id: next._id }, { $set: { primary: true } });
      return;
    }
    const next = await this.cards.findOne({ userId: owner }).sort({ createdAt: 1 }).lean();
    if (next) await this.cards.updateOne({ _id: next._id }, { $set: { primary: true } });
  }

  /** Primary is per kind: one bank payouts default to, one card checkout defaults to. */
  async setPrimary(userId: string, id: string): Promise<{ primary: true }> {
    if (!Types.ObjectId.isValid(id)) throw Errors.notFound('That payment account is not on your profile.', 'ACCOUNT_NOT_FOUND');
    const owner = new Types.ObjectId(userId);
    if (await this.accounts.exists({ _id: id, userId: owner })) {
      await this.accounts.updateMany({ userId: owner }, { $set: { primary: false } });
      await this.accounts.updateOne({ _id: id }, { $set: { primary: true } });
      return { primary: true };
    }
    if (await this.cards.exists({ _id: id, userId: owner })) {
      await this.cards.updateMany({ userId: owner }, { $set: { primary: false } });
      await this.cards.updateOne({ _id: id }, { $set: { primary: true } });
      return { primary: true };
    }
    throw Errors.notFound('That payment account is not on your profile.', 'ACCOUNT_NOT_FOUND');
  }
}
