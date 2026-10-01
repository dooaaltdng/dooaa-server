import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import { payoutReference } from '../../common/util/ids';
import { formatNaira, fromKobo, toKobo } from '../../common/util/money';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { AuditService } from '../audit/audit.service';
import { PaymentMethodsService } from '../payments/payment-methods.service';
import { PAYMENT_EVENTS, type TransferUpdated } from '../payments/payments.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/providers/payment-provider';
import { SettingsService } from '../settings/settings.service';
import { PasswordService } from '../users/password.service';
import { User } from '../users/schemas/user.schema';
import { Earning, Payout, Wallet } from './wallet.schema';

export const WALLET_EVENTS = {
  payoutUpdated: 'wallet.payout-updated',
} as const;

export type PayoutUpdated = { payout: Lean<Payout> };

export type WalletOverview = { available: number; pending: number; withdrawn: number };

export type EarningView = { id: string; orderId: string; orderNumber: string; product: string; amount: number; status: Earning['status']; at: string };

export type PayoutView = {
  id: string;
  reference: string;
  amount: number;
  /** "Bank Account" — PayPal is not a rail the provider pays out on. */
  destination: 'Bank Account';
  bankName: string;
  accountName: string;
  last4: string;
  status: Payout['status'];
  at: string;
  completedAt: string | null;
  failureReason: string | null;
};

export type OrderForWallet = {
  _id: Types.ObjectId;
  sellerId: Types.ObjectId;
  reference: string;
  sellerEarning: number;
  items: { title: string }[];
};

@Injectable()
export class WalletService implements OnModuleInit {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectModel(Wallet.name) private readonly wallets: Model<Wallet>,
    @InjectModel(Earning.name) private readonly earnings: Model<Earning>,
    @InjectModel(Payout.name) private readonly payouts: Model<Payout>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly methods: PaymentMethodsService,
    private readonly passwords: PasswordService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<TransferUpdated>(PAYMENT_EVENTS.transferUpdated, (event) => this.applyTransfer(event));
  }

  private async bump(sellerId: Types.ObjectId | string, inc: Partial<Record<'availableKobo' | 'pendingKobo' | 'withdrawnKobo', number>>, requireAvailable?: number): Promise<boolean> {
    const filter: Record<string, unknown> = { sellerId: new Types.ObjectId(String(sellerId)) };
    if (requireAvailable !== undefined) filter.availableKobo = { $gte: requireAvailable };
    const result = await this.wallets.updateOne(filter, { $inc: inc }, { upsert: requireAvailable === undefined });
    return result.modifiedCount > 0 || result.upsertedCount > 0;
  }

  /* --- Escrow hooks (idempotent per order) ----------------------------------- */

  /** Payment confirmed: the seller's earning is now pending in escrow. */
  async onFunded(order: OrderForWallet): Promise<void> {
    const result = await this.earnings.updateOne(
      { orderId: order._id },
      {
        $setOnInsert: {
          sellerId: order.sellerId,
          orderId: order._id,
          orderNumber: `#${order.reference}`,
          product: order.items[0]?.title ?? 'Order',
          amount: order.sellerEarning,
          status: 'pending',
          fundedAt: new Date(),
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount) await this.bump(order.sellerId, { pendingKobo: toKobo(order.sellerEarning) });
  }

  /** Escrow released: the earning becomes withdrawable (and is paid out at once if auto-payout is on). */
  async onReleased(order: OrderForWallet): Promise<void> {
    const earning = await this.earnings.findOneAndUpdate(
      { orderId: order._id, status: 'pending' },
      { $set: { status: 'available', releasedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!earning) return;
    const kobo = toKobo(earning.amount);
    await this.bump(order.sellerId, { pendingKobo: -kobo, availableKobo: kobo });
    const commerce = await this.settings.section('commerce');
    if (commerce.autoPayout) {
      await this.autoPayout(String(order.sellerId), earning.amount).catch((error) =>
        this.logger.warn(`Auto-payout for ${String(order.sellerId)} not started: ${(error as Error).message}`),
      );
    }
  }

  /** Refunded before release: the pending earning is cancelled. */
  async onCancelled(order: OrderForWallet): Promise<void> {
    const earning = await this.earnings.findOneAndUpdate(
      { orderId: order._id, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (earning) await this.bump(order.sellerId, { pendingKobo: -toKobo(earning.amount) });
  }

  /**
   * A released decision is reversed: the earning goes back on hold. Only
   * possible while the seller has not already withdrawn it.
   */
  async onReversed(order: OrderForWallet): Promise<void> {
    const earning = await this.earnings.findOne({ orderId: order._id, status: 'available' }).lean();
    if (!earning) return;
    const kobo = toKobo(earning.amount);
    const debited = await this.bump(order.sellerId, { availableKobo: -kobo, pendingKobo: kobo }, kobo);
    if (!debited) {
      throw Errors.conflict('The seller has already withdrawn these funds, so the decision cannot be reversed from the console.', 'FUNDS_WITHDRAWN');
    }
    await this.earnings.updateOne({ _id: earning._id }, { $set: { status: 'pending' }, $unset: { releasedAt: 1 } });
  }

  /* --- Reads ---------------------------------------------------------------- */

  async overview(sellerId: string): Promise<WalletOverview> {
    const wallet = await this.wallets.findOne({ sellerId: new Types.ObjectId(sellerId) }).lean();
    return {
      available: fromKobo(wallet?.availableKobo ?? 0),
      pending: fromKobo(wallet?.pendingKobo ?? 0),
      withdrawn: fromKobo(wallet?.withdrawnKobo ?? 0),
    };
  }

  private earningView(row: Lean<Earning>): EarningView {
    return {
      id: String(row._id),
      orderId: String(row.orderId),
      orderNumber: row.orderNumber,
      product: row.product,
      amount: row.amount,
      status: row.status,
      at: new Date(row.releasedAt ?? row.fundedAt).toISOString(),
    };
  }

  private payoutView(row: Lean<Payout>): PayoutView {
    return {
      id: String(row._id),
      reference: row.reference,
      amount: row.amount,
      destination: 'Bank Account',
      bankName: row.destination.bankName,
      accountName: row.destination.accountName,
      last4: row.destination.last4,
      status: row.status,
      at: new Date(row.createdAt).toISOString(),
      completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
      failureReason: row.failureReason ?? null,
    };
  }

  /** Earnings & Payouts: the three overview figures, released earnings and payout history. */
  async summary(sellerId: string, page = 1, limit = 20) {
    const owner = new Types.ObjectId(sellerId);
    const [overview, earnings, payouts, minimum] = await Promise.all([
      this.overview(sellerId),
      this.earnings.find({ sellerId: owner, status: 'available' }).sort({ releasedAt: -1 }).limit(50).lean<Lean<Earning>[]>(),
      this.payoutPage(sellerId, page, limit),
      this.settings.section('commerce').then((commerce) => commerce.minimumWithdrawal),
    ]);
    return { overview, minimumWithdrawal: minimum, earnings: earnings.map((row) => this.earningView(row)), payouts };
  }

  async payoutPage(sellerId: string, page = 1, limit = 20): Promise<Page<PayoutView>> {
    const filter = { sellerId: new Types.ObjectId(sellerId) };
    const total = await this.payouts.countDocuments(filter);
    const window = pageWindow(total, page, limit);
    const rows = await this.payouts.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Payout>[]>();
    return toPage(rows.map((row) => this.payoutView(row)), total, window);
  }

  /* --- Withdrawals ------------------------------------------------------------ */

  /**
   * The Withdraw dialog. Re-confirms the password, takes the amount out of
   * the available balance atomically (two simultaneous withdrawals cannot
   * both pass) and asks the provider to transfer it.
   */
  async requestPayout(user: AuthUser, input: { amount: number; password: string; accountId?: string; destination?: string }): Promise<PayoutView> {
    if (input.destination && input.destination !== 'bank') {
      throw Errors.badRequest('Payouts go to a Nigerian bank account. Add one under Payment accounts.', 'PAYOUT_METHOD_UNAVAILABLE');
    }
    const record = await this.users.findById(user.id).select('+passwordHash').lean();
    if (!(await this.passwords.verify(input.password, record?.passwordHash))) {
      throw Errors.badRequest('That password is incorrect.', 'INVALID_PASSWORD');
    }
    const minimum = (await this.settings.section('commerce')).minimumWithdrawal;
    if (input.amount < minimum) throw Errors.badRequest(`The minimum withdrawal is ${formatNaira(minimum)}.`, 'BELOW_MINIMUM_WITHDRAWAL');
    return this.startPayout(user.id, input.amount, input.accountId, false);
  }

  private async autoPayout(sellerId: string, amount: number): Promise<void> {
    await this.startPayout(sellerId, amount, undefined, true);
  }

  private async startPayout(sellerId: string, amount: number, accountId: string | undefined, automatic: boolean): Promise<PayoutView> {
    const account = await this.methods.payoutAccount(sellerId, accountId);
    if (!account) throw Errors.badRequest('Add a bank account under Payment accounts before withdrawing.', 'NO_PAYOUT_ACCOUNT');
    if (!account.verified) throw Errors.badRequest('That bank account has not been verified yet.', 'PAYOUT_ACCOUNT_UNVERIFIED');

    const kobo = toKobo(amount);
    if (kobo <= 0) throw Errors.badRequest('Enter an amount to withdraw.', 'VALIDATION_FAILED');
    const debited = await this.bump(sellerId, { availableKobo: -kobo }, kobo);
    if (!debited) throw Errors.badRequest('That is more than your available balance.', 'INSUFFICIENT_BALANCE');

    const payout = await this.payouts.create({
      sellerId: new Types.ObjectId(sellerId),
      reference: payoutReference(),
      amount: fromKobo(kobo),
      destination: {
        accountId: account._id,
        bankName: account.bankName,
        accountName: account.accountName,
        last4: account.last4,
        recipientCode: account.recipientCode,
      },
      status: 'processing',
      automatic,
      attempts: 1,
    });
    return this.payoutView(await this.transfer(payout.toObject() as Lean<Payout>));
  }

  /** Hands the payout to the provider. A refusal returns the money to the available balance. */
  private async transfer(payout: Lean<Payout>): Promise<Lean<Payout>> {
    try {
      const result = await this.provider.initiateTransfer({
        amount: payout.amount,
        recipientCode: payout.destination.recipientCode,
        reference: payout.reference,
        reason: 'DOOAA seller payout',
      });
      await this.payouts.updateOne({ _id: payout._id }, { $set: { transferCode: result.transferCode } });
      if (result.status === 'success') await this.applyTransfer({ reference: payout.reference, status: 'success', transferCode: result.transferCode });
      if (result.status === 'failed') await this.applyTransfer({ reference: payout.reference, status: 'failed', transferCode: result.transferCode, reason: 'Refused by the provider' });
    } catch (error) {
      await this.applyTransfer({ reference: payout.reference, status: 'failed', reason: (error as Error).message });
      throw error;
    }
    return (await this.payouts.findById(payout._id).lean<Lean<Payout>>())!;
  }

  /** The provider's word on a transfer. Idempotent: each payout settles once. */
  async applyTransfer(event: TransferUpdated): Promise<void> {
    if (event.status === 'success') {
      const payout = await this.payouts
        .findOneAndUpdate({ reference: event.reference, status: 'processing' }, { $set: { status: 'completed', completedAt: new Date() } }, { returnDocument: 'after' })
        .lean<Lean<Payout>>();
      if (!payout) return;
      await this.bump(payout.sellerId, { withdrawnKobo: toKobo(payout.amount) });
      await this.events.emit<PayoutUpdated>(WALLET_EVENTS.payoutUpdated, { payout });
      return;
    }
    // Failed or reversed: the money comes back to the available balance.
    const payout = await this.payouts
      .findOneAndUpdate(
        { reference: event.reference, status: { $in: event.status === 'reversed' ? ['processing', 'completed'] : ['processing'] } },
        { $set: { status: 'failed', failedAt: new Date(), failureReason: event.reason ?? (event.status === 'reversed' ? 'Reversed by the bank' : 'Transfer failed') } },
        { returnDocument: 'before' },
      )
      .lean<Lean<Payout>>();
    if (!payout) return;
    const kobo = toKobo(payout.amount);
    await this.bump(payout.sellerId, { availableKobo: kobo, ...(payout.status === 'completed' ? { withdrawnKobo: -kobo } : {}) });
    const latest = (await this.payouts.findById(payout._id).lean<Lean<Payout>>())!;
    await this.events.emit<PayoutUpdated>(WALLET_EVENTS.payoutUpdated, { payout: latest });
  }

  /* --- Console ----------------------------------------------------------------- */

  async adminPayouts(query: { status?: Payout['status']; page?: number; limit?: number }): Promise<Page<PayoutView & { sellerId: string; sellerName: string; sellerEmail: string }>> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    const total = await this.payouts.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 20);
    const rows = await this.payouts.find(filter).sort({ createdAt: -1 }).skip(window.skip).limit(window.size).lean<Lean<Payout>[]>();
    const sellers = await this.users.find({ _id: { $in: rows.map((row) => row.sellerId) } }).select('firstName lastName email').lean();
    const byId = new Map(sellers.map((seller) => [String(seller._id), seller]));
    return toPage(
      rows.map((row) => {
        const seller = byId.get(String(row.sellerId));
        return {
          ...this.payoutView(row),
          sellerId: String(row.sellerId),
          sellerName: seller ? `${seller.firstName} ${seller.lastName}` : 'Unknown seller',
          sellerEmail: seller?.email ?? '',
        };
      }),
      total,
      window,
    );
  }

  /** Re-sends a failed payout to the provider (e.g. after the seller fixed their bank). */
  async retryPayout(staff: AuthStaff, id: string): Promise<PayoutView> {
    const payout = await this.payouts.findById(id).lean<Lean<Payout>>();
    if (!payout) throw Errors.notFound('That payout does not exist.', 'PAYOUT_NOT_FOUND');
    if (payout.status !== 'failed') throw Errors.conflict('Only a failed payout can be retried.', 'PAYOUT_NOT_FAILED');
    const kobo = toKobo(payout.amount);
    const debited = await this.bump(payout.sellerId, { availableKobo: -kobo }, kobo);
    if (!debited) throw Errors.conflict('The seller no longer has that much available.', 'INSUFFICIENT_BALANCE');
    const account = await this.methods.payoutAccount(String(payout.sellerId));
    if (!account) {
      await this.bump(payout.sellerId, { availableKobo: kobo });
      throw Errors.conflict('The seller has no payout account on file.', 'NO_PAYOUT_ACCOUNT');
    }
    const fresh = await this.payouts
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status: 'processing',
            reference: payoutReference(),
            destination: { accountId: account._id, bankName: account.bankName, accountName: account.accountName, last4: account.last4, recipientCode: account.recipientCode },
          },
          $unset: { failureReason: 1, failedAt: 1, transferCode: 1 },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      )
      .lean<Lean<Payout>>();
    await this.audit.record(staff, { action: 'Retried a seller payout', target: `${formatNaira(payout.amount)} to ${account.bankName} ****${account.last4}`, targetType: 'payout', targetId: id });
    return this.payoutView(await this.transfer(fresh!).catch(async () => (await this.payouts.findById(id).lean<Lean<Payout>>())!));
  }

  /** Rebuilds a wallet from its history — used by tests and support to prove the books balance. */
  async recompute(sellerId: string): Promise<WalletOverview> {
    const owner = new Types.ObjectId(sellerId);
    const [earnings, payouts] = await Promise.all([
      this.earnings.find({ sellerId: owner }).lean(),
      this.payouts.find({ sellerId: owner }).lean(),
    ]);
    const sum = (values: number[]) => values.reduce((total, value) => total + toKobo(value), 0);
    const pending = sum(earnings.filter((row) => row.status === 'pending').map((row) => row.amount));
    const released = sum(earnings.filter((row) => row.status === 'available').map((row) => row.amount));
    const withdrawn = sum(payouts.filter((row) => row.status === 'completed').map((row) => row.amount));
    const inFlight = sum(payouts.filter((row) => row.status === 'processing').map((row) => row.amount));
    return { available: fromKobo(released - withdrawn - inFlight), pending: fromKobo(pending), withdrawn: fromKobo(withdrawn) };
  }

  /** True when any money is still owed to or held for this seller. */
  async hasOpenBalance(sellerId: string): Promise<boolean> {
    const overview = await this.overview(sellerId);
    const processing = await this.payouts.countDocuments({ sellerId: new Types.ObjectId(sellerId), status: 'processing' });
    return overview.pending > 0 || overview.available > 0 || processing > 0;
  }
}
