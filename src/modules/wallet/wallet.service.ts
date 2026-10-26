import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import type { EarningStatus, PayoutStatus } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { payoutReference } from '../../common/util/ids';
import { formatNaira, fromKobo, toKobo } from '../../common/util/money';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { earnings, payouts, users, wallets } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { PaymentMethodsService, type PayoutAccount } from '../payments/payment-methods.service';
import { PAYMENT_EVENTS, type PayoutSettled } from '../payments/payments.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/providers/payment-provider';
import { SettingsService } from '../settings/settings.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import { explain } from '../../common/util/explain-error';

export const WALLET_EVENTS = {
  payoutUpdated: 'wallet.payout-updated',
} as const;

export type Earning = typeof earnings.$inferSelect;
export type Payout = typeof payouts.$inferSelect;

export type PayoutUpdated = { payout: Payout };

export type WalletOverview = { available: number; pending: number; withdrawn: number };

export type EarningView = { id: string; orderId: string; orderNumber: string; product: string; amount: number; status: EarningStatus; at: string };

export type PayoutView = {
  id: string;
  reference: string;
  amount: number;
  /** "Bank Account" — PayPal is not a rail the provider pays out on. */
  destination: 'Bank Account';
  bankName: string;
  accountName: string;
  last4: string;
  status: PayoutStatus;
  at: string;
  completedAt: string | null;
  failureReason: string | null;
};

export type OrderForWallet = {
  id: string;
  sellerId: string;
  reference: string;
  sellerEarning: number;
  items: { title: string }[];
};

type BalanceChange = Partial<Record<'availableKobo' | 'pendingKobo' | 'withdrawnKobo', number>>;

@Injectable()
export class WalletService implements OnModuleInit {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly methods: PaymentMethodsService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<PayoutSettled>(PAYMENT_EVENTS.payoutSettled, (event) => this.applyPayout(event));
  }

  /**
   * Moves a seller's balances in one statement. With `requireAvailable`, the
   * change only happens if that much is available — two withdrawals at once
   * cannot both pass. Without it, the wallet is created on first use.
   */
  private async bump(sellerId: string, change: BalanceChange, requireAvailable?: number): Promise<boolean> {
    const inc = {
      $inc: { availableKobo: change.availableKobo ?? 0, pendingKobo: change.pendingKobo ?? 0, withdrawnKobo: change.withdrawnKobo ?? 0 },
    };
    if (requireAvailable !== undefined) {
      const updated = await this.db.update(wallets, { sellerId, availableKobo: { $gte: requireAvailable } }, inc);
      return updated !== null;
    }
    await this.db.upsert(wallets, { sellerId }, inc);
    return true;
  }

  /* --- Escrow hooks (idempotent per order) ----------------------------------- */

  /** Payment confirmed: the seller's earning is now pending in escrow. */
  async onFunded(order: OrderForWallet): Promise<void> {
    const created = await this.db.insertIgnoringDuplicates(earnings, [
      {
        sellerId: order.sellerId,
        orderId: order.id,
        orderNumber: `#${order.reference}`,
        product: order.items[0]?.title ?? 'Order',
        amount: order.sellerEarning,
        status: 'pending',
        fundedAt: new Date(),
      },
    ]);
    if (created) await this.bump(order.sellerId, { pendingKobo: toKobo(order.sellerEarning) });
  }

  /** Escrow released: the earning becomes withdrawable (and is paid out at once if auto-payout is on). */
  async onReleased(order: OrderForWallet): Promise<void> {
    const earning = await this.db.update(earnings, { orderId: order.id, status: 'pending' }, { status: 'available', releasedAt: new Date() });
    if (!earning) return;
    const kobo = toKobo(earning.amount);
    await this.bump(order.sellerId, { pendingKobo: -kobo, availableKobo: kobo });
    const commerce = await this.settings.section('commerce');
    if (commerce.autoPayout) {
      await this.startPayout(order.sellerId, earning.amount, undefined, true).catch((error: Error) =>
        this.logger.warn(explain(`The automatic payout to seller ${order.sellerId} did not start`, error)),
      );
    }
  }

  /** Refunded before release: the pending earning is cancelled. */
  async onCancelled(order: OrderForWallet): Promise<void> {
    const earning = await this.db.update(earnings, { orderId: order.id, status: 'pending' }, { status: 'cancelled', cancelledAt: new Date() });
    if (earning) await this.bump(order.sellerId, { pendingKobo: -toKobo(earning.amount) });
  }

  /**
   * A released decision is reversed: the earning goes back on hold. Only
   * possible while the seller has not already withdrawn it.
   */
  async onReversed(order: OrderForWallet): Promise<void> {
    const earning = await this.db.findOne(earnings, { orderId: order.id, status: 'available' });
    if (!earning) return;
    const kobo = toKobo(earning.amount);
    const debited = await this.bump(order.sellerId, { availableKobo: -kobo, pendingKobo: kobo }, kobo);
    if (!debited) {
      throw Errors.conflict('The seller has already withdrawn these funds, so the decision cannot be reversed from the console.', 'FUNDS_WITHDRAWN');
    }
    await this.db.update(earnings, { id: earning.id }, { status: 'pending', releasedAt: null });
  }

  /* --- Reads ---------------------------------------------------------------- */

  async overview(sellerId: string): Promise<WalletOverview> {
    const wallet = await this.db.findOne(wallets, { sellerId });
    return {
      available: fromKobo(wallet?.availableKobo ?? 0),
      pending: fromKobo(wallet?.pendingKobo ?? 0),
      withdrawn: fromKobo(wallet?.withdrawnKobo ?? 0),
    };
  }

  private earningView(row: Earning): EarningView {
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      product: row.product,
      amount: row.amount,
      status: row.status,
      at: (row.releasedAt ?? row.fundedAt).toISOString(),
    };
  }

  private payoutView(row: Payout): PayoutView {
    return {
      id: row.id,
      reference: row.reference,
      amount: row.amount,
      destination: 'Bank Account',
      bankName: row.destination.bankName,
      accountName: row.destination.accountName,
      last4: row.destination.last4,
      status: row.status,
      at: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
    };
  }

  /** Earnings & Payouts: the three overview figures, released earnings and payout history. */
  async summary(sellerId: string, page = 1, limit = 20) {
    const [overview, released, payoutPage, minimum] = await Promise.all([
      this.overview(sellerId),
      this.db.find(earnings, { sellerId, status: 'available' }, { sort: { releasedAt: -1 }, limit: 50 }),
      this.payoutPage(sellerId, page, limit),
      this.settings.section('commerce').then((commerce) => commerce.minimumWithdrawal),
    ]);
    return { overview, minimumWithdrawal: minimum, earnings: released.map((row) => this.earningView(row)), payouts: payoutPage };
  }

  async payoutPage(sellerId: string, page = 1, limit = 20): Promise<Page<PayoutView>> {
    const where = { sellerId };
    const total = await this.db.count(payouts, where);
    const window = pageWindow(total, page, limit);
    const rows = await this.db.find(payouts, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size });
    return toPage(
      rows.map((row) => this.payoutView(row)),
      total,
      window,
    );
  }

  /* --- Withdrawals ------------------------------------------------------------ */

  /**
   * The Withdraw dialog. Re-confirms the password, takes the amount out of
   * the available balance atomically (two simultaneous withdrawals cannot
   * both pass) and asks Bachs to pay it out.
   */
  async requestPayout(user: AuthUser, input: { amount: number; password: string; accountId?: string; destination?: string }): Promise<PayoutView> {
    if (input.destination && input.destination !== 'bank') {
      throw Errors.badRequest('Payouts go to a Nigerian bank account. Add one under Payment accounts.', 'PAYOUT_METHOD_UNAVAILABLE');
    }
    if (!(await this.passwords.verify(input.password, await this.users.passwordHashOf(user.id)))) {
      throw Errors.badRequest('That password is incorrect.', 'INVALID_PASSWORD');
    }
    const minimum = (await this.settings.section('commerce')).minimumWithdrawal;
    if (input.amount < minimum) throw Errors.badRequest(`The minimum withdrawal is ${formatNaira(minimum)}.`, 'BELOW_MINIMUM_WITHDRAWAL');
    return this.startPayout(user.id, input.amount, input.accountId, false);
  }

  /** The account a payout goes to, once Bachs has approved it. */
  private async usableAccount(sellerId: string, accountId?: string): Promise<PayoutAccount> {
    const account = await this.methods.payoutAccount(sellerId, accountId);
    if (!account) throw Errors.badRequest('Add a bank account under Payment accounts before withdrawing.', 'NO_PAYOUT_ACCOUNT');
    if (!(await this.methods.ensureUsable(account))) {
      throw Errors.badRequest('That bank account is still being reviewed by our payment partner. Try again once it is approved.', 'PAYOUT_ACCOUNT_UNVERIFIED');
    }
    return account;
  }

  private async startPayout(sellerId: string, amount: number, accountId: string | undefined, automatic: boolean): Promise<PayoutView> {
    const account = await this.usableAccount(sellerId, accountId);
    const kobo = toKobo(amount);
    if (kobo <= 0) throw Errors.badRequest('Enter an amount to withdraw.', 'VALIDATION_FAILED');
    const debited = await this.bump(sellerId, { availableKobo: -kobo }, kobo);
    if (!debited) throw Errors.badRequest('That is more than your available balance.', 'INSUFFICIENT_BALANCE');

    const payout = await this.db.insert(payouts, {
        sellerId,
        reference: payoutReference(),
        amount: fromKobo(kobo),
        destination: {
          accountId: account.id,
          bankName: account.bankName,
          accountName: account.accountName,
          last4: account.last4,
          recipientCode: account.recipientCode,
        },
        status: 'processing',
        automatic,
        attempts: 1,
      });
    return this.payoutView(await this.send(payout));
  }

  /** Hands the payout to Bachs. A refusal returns the money to the available balance. */
  private async send(payout: Payout): Promise<Payout> {
    try {
      const result = await this.provider.createPayout({
        destinationId: payout.destination.recipientCode,
        amount: payout.amount,
        reference: payout.reference,
      });
      await this.db.update(payouts, { id: payout.id }, { transferCode: result.payoutId });
      if (result.status !== 'pending') {
        await this.applyPayout({ reference: payout.reference, status: result.status, payoutId: result.payoutId, reason: result.failureReason ?? 'Refused by the provider' });
      }
    } catch (error) {
      await this.applyPayout({ reference: payout.reference, status: 'failed', reason: (error as Error).message });
      throw error;
    }
    return this.payoutById(payout.id);
  }

  private async payoutById(id: string): Promise<Payout> {
    return (await this.db.findOne(payouts, { id }))!;
  }

  /** Bachs' word on a payout. Idempotent: each payout settles once. */
  async applyPayout(event: PayoutSettled): Promise<void> {
    if (event.status === 'success') {
      const payout = await this.db.update(
        payouts,
        { reference: event.reference, status: 'processing' },
        { status: 'completed', completedAt: new Date(), ...(event.payoutId ? { transferCode: event.payoutId } : {}) },
      );
      if (!payout) return;
      await this.bump(payout.sellerId, { withdrawnKobo: toKobo(payout.amount) });
      await this.events.emit<PayoutUpdated>(WALLET_EVENTS.payoutUpdated, { payout });
      return;
    }
    // Failed: the money comes back to the available balance.
    const payout = await this.db.update(
      payouts,
      { reference: event.reference, status: 'processing' },
      { status: 'failed', failedAt: new Date(), failureReason: event.reason ?? 'Payout failed' },
    );
    if (!payout) return;
    await this.bump(payout.sellerId, { availableKobo: toKobo(payout.amount) });
    await this.events.emit<PayoutUpdated>(WALLET_EVENTS.payoutUpdated, { payout });
  }

  /* --- Console ----------------------------------------------------------------- */

  async adminPayouts(query: { status?: PayoutStatus; page?: number; limit?: number }): Promise<Page<PayoutView & { sellerId: string; sellerName: string; sellerEmail: string }>> {
    const where = query.status ? { status: query.status } : {};
    const total = await this.db.count(payouts, where);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.db.find(payouts, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size });
    const sellers = new Map((await this.db.find(users, { id: { $in: rows.map((row) => row.sellerId) } })).map((user) => [user.id, user]));
    return toPage(
      rows.map((payout) => {
        const seller = sellers.get(payout.sellerId);
        return {
          ...this.payoutView(payout),
          sellerId: payout.sellerId,
          sellerName: seller ? `${seller.firstName} ${seller.lastName}` : 'Unknown seller',
          sellerEmail: seller?.email ?? '',
        };
      }),
      total,
      window,
    );
  }

  /** Re-sends a failed payout to Bachs (e.g. after the seller fixed their bank). */
  async retryPayout(staff: AuthStaff, id: string): Promise<PayoutView> {
    const payout = isUuid(id) ? await this.payoutById(id) : undefined;
    if (!payout) throw Errors.notFound('That payout does not exist.', 'PAYOUT_NOT_FOUND');
    if (payout.status !== 'failed') throw Errors.conflict('Only a failed payout can be retried.', 'PAYOUT_NOT_FAILED');
    const account = await this.usableAccount(payout.sellerId).catch((error: Error) => {
      throw Errors.conflict(error.message, 'NO_PAYOUT_ACCOUNT');
    });
    const kobo = toKobo(payout.amount);
    const debited = await this.bump(payout.sellerId, { availableKobo: -kobo }, kobo);
    if (!debited) throw Errors.conflict('The seller no longer has that much available.', 'INSUFFICIENT_BALANCE');
    const fresh = await this.db.update(
      payouts,
      { id, status: 'failed' },
      {
        $set: {
        status: 'processing',
        // A new reference: Bachs treats a reference (and its idempotency key) as one payout, forever.
        reference: payoutReference(),
        destination: { accountId: account.id, bankName: account.bankName, accountName: account.accountName, last4: account.last4, recipientCode: account.recipientCode },
        failureReason: null,
        failedAt: null,
        transferCode: null,
        },
        $inc: { attempts: 1 },
      },
    );
    if (!fresh) {
      await this.bump(payout.sellerId, { availableKobo: kobo });
      throw Errors.conflict('Only a failed payout can be retried.', 'PAYOUT_NOT_FAILED');
    }
    await this.audit.record(staff, { action: 'Retried a seller payout', target: `${formatNaira(payout.amount)} to ${account.bankName} ****${account.last4}`, targetType: 'payout', targetId: id });
    return this.payoutView(await this.send(fresh).catch(() => this.payoutById(id)));
  }

  /** Rebuilds a wallet from its history — used by tests and support to prove the books balance. */
  async recompute(sellerId: string): Promise<WalletOverview> {
    const [earningRows, payoutRows] = await Promise.all([
      this.db.find(earnings, { sellerId }),
      this.db.find(payouts, { sellerId }),
    ]);
    const sum = (values: number[]) => values.reduce((total, value) => total + toKobo(value), 0);
    const pending = sum(earningRows.filter((row) => row.status === 'pending').map((row) => row.amount));
    const released = sum(earningRows.filter((row) => row.status === 'available').map((row) => row.amount));
    const withdrawn = sum(payoutRows.filter((row) => row.status === 'completed').map((row) => row.amount));
    const inFlight = sum(payoutRows.filter((row) => row.status === 'processing').map((row) => row.amount));
    return { available: fromKobo(released - withdrawn - inFlight), pending: fromKobo(pending), withdrawn: fromKobo(withdrawn) };
  }

  /** True when any money is still owed to or held for this seller. */
  async hasOpenBalance(sellerId: string): Promise<boolean> {
    const overview = await this.overview(sellerId);
    const processing = await this.db.count(payouts, { sellerId, status: 'processing' });
    return overview.pending > 0 || overview.available > 0 || processing > 0;
  }
}
