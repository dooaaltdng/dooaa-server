import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheService } from '../../cache/cache.service';
import { Errors } from '../../common/api/app-error';
import type { PayoutAccountSource } from '../../common/domain';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { payoutAccounts } from '../../database/schema';
import { PAYMENT_PROVIDER, type Bank, type PaymentProvider } from './providers/payment-provider';
import { explain } from '../../common/util/explain-error';

export type PayoutAccount = typeof payoutAccounts.$inferSelect;

/**
 * One row of the settings panel's "Payment accounts": the banks a seller is
 * paid into. Cards are never stored — buyers enter them on Bachs' page.
 */
export type PaymentAccountView = {
  id: string;
  type: 'bank';
  /** The bank's name. */
  issuer: string;
  holder: string;
  last4: string;
  /** Bachs approved the account for payouts (new accounts are reviewed first). */
  verified: boolean;
  primary: boolean;
  bankCode: string;
};

const BANKS_CACHE_KEY = 'payments:banks';
const BANKS_TTL_MS = 60 * 60_000;

function fingerprint(bankCode: string, accountNumber: string): string {
  return createHash('sha256').update(`${bankCode}:${accountNumber}`).digest('hex');
}

@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly cache: CacheService,
  ) {}

  /* --- Banks ---------------------------------------------------------------- */

  listBanks(): Promise<Bank[]> {
    return this.cache.wrap(BANKS_CACHE_KEY, BANKS_TTL_MS, () => this.provider.listBanks());
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

  private accountView(row: PayoutAccount, holder?: string): PaymentAccountView {
    return {
      id: row.id,
      type: 'bank',
      issuer: row.bankName,
      holder: holder ?? row.accountName,
      last4: row.last4,
      verified: row.verified,
      primary: row.primary,
      bankCode: row.bankCode,
    };
  }

  /**
   * Resolves the account with the bank, registers it with Bachs as a payout
   * destination and saves it. Adding the same account again refreshes it.
   */
  async addPayoutAccount(
    userId: string,
    input: { bankCode: string; accountNumber: string; primary?: boolean },
    source: PayoutAccountSource = 'settings',
  ): Promise<PaymentAccountView> {
    const resolved = await this.resolveAccount(input.accountNumber, input.bankCode);
    const destination = await this.provider.createPayoutDestination({
      accountName: resolved.accountName,
      accountNumber: input.accountNumber,
      bankCode: input.bankCode,
      label: `DOOAA seller ${userId}`,
    });
    const total = await this.db.count(payoutAccounts, { userId });
    const primary = input.primary === true || total === 0;
    const details = {
      provider: this.provider.name,
      bankCode: input.bankCode,
      bankName: resolved.bankName,
      accountName: resolved.accountName,
      last4: input.accountNumber.slice(-4),
      recipientCode: destination.destinationId,
      verified: destination.usable,
      source,
    };
    const row = await this.db.transaction(async (tx) => {
      if (primary) await tx.updateMany(payoutAccounts, { userId }, { primary: false });
      return tx.upsert(
        payoutAccounts,
        { userId, fingerprint: fingerprint(input.bankCode, input.accountNumber) },
        { ...details, ...(primary ? { primary: true } : {}) },
        { primary },
      );
    });
    return this.accountView(row);
  }

  async payoutAccounts(userId: string): Promise<PaymentAccountView[]> {
    const rows = await this.db.find(payoutAccounts, { userId }, { sort: { primary: -1, createdAt: 1 } });
    return rows.map((row) => this.accountView(row));
  }

  /** The chosen account, or the primary one. */
  async payoutAccount(userId: string, id?: string): Promise<PayoutAccount | null> {
    if (id !== undefined && !isUuid(id)) return null;
    return this.db.findOne(payoutAccounts, { userId, ...(id ? { id } : {}) }, { sort: { primary: -1, createdAt: 1 } });
  }

  /**
   * Whether Bachs has approved the account for payouts, asking Bachs again
   * while it is still under review and remembering the answer.
   */
  async ensureUsable(account: PayoutAccount): Promise<boolean> {
    if (account.verified) return true;
    const destination = await this.provider.getPayoutDestination(account.recipientCode).catch((error: Error) => {
      this.logger.warn(explain(`Could not confirm the payout bank account ${account.recipientCode} with the payment provider`, error));
      return null;
    });
    if (!destination?.usable) return false;
    await this.db.update(payoutAccounts, { id: account.id }, { verified: true });
    return true;
  }

  /* --- The settings panel ---------------------------------------------------- */

  async accountsFor(userId: string, holder: string): Promise<PaymentAccountView[]> {
    const rows = await this.db.find(payoutAccounts, { userId }, { sort: { primary: -1, createdAt: 1 } });
    return rows.map((row) => this.accountView(row, holder));
  }

  async remove(userId: string, id: string): Promise<{ removed: true }> {
    const removed = await this.db.transaction(async (tx) => {
      const row = isUuid(id) ? await tx.delete(payoutAccounts, { id, userId }) : null;
      if (row?.primary) {
        const next = await tx.findOne(payoutAccounts, { userId }, { sort: { createdAt: 1 } });
        if (next) await tx.update(payoutAccounts, { id: next.id }, { primary: true });
      }
      return row;
    });
    if (!removed) throw Errors.notFound('That payment account is not on your profile.', 'ACCOUNT_NOT_FOUND');
    return { removed: true };
  }

  /** The bank payouts default to. */
  async setPrimary(userId: string, id: string): Promise<{ primary: true }> {
    const updated = await this.db.transaction(async (tx) => {
      const owned = isUuid(id) ? await tx.findOne(payoutAccounts, { id, userId }) : null;
      if (!owned) return false;
      await tx.updateMany(payoutAccounts, { userId }, { primary: false });
      await tx.update(payoutAccounts, { id }, { primary: true });
      return true;
    });
    if (!updated) throw Errors.notFound('That payment account is not on your profile.', 'ACCOUNT_NOT_FOUND');
    return { primary: true };
  }
}
