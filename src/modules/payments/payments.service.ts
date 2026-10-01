import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { EventBus } from '../../common/events/event-bus';
import type { CheckoutMethod } from '../../common/domain';
import { paymentReference, refundReference } from '../../common/util/ids';
import { sumMoney, toKobo } from '../../common/util/money';
import type { Lean } from '../../common/util/mongo';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { PaymentMethodsService } from './payment-methods.service';
import {
  PAYMENT_PROVIDER,
  type ChargeChannel,
  type ChargeStatus,
  type PaymentProvider,
  type ProviderEvent,
} from './providers/payment-provider';
import { SandboxProvider } from './providers/sandbox.provider';
import { Payment, type PaymentRefund } from './schemas/payment.schema';

export const PAYMENT_EVENTS = {
  /** A charge was confirmed by the provider: fulfil the orders it paid for. */
  succeeded: 'payment.succeeded',
  /** A charge failed or was abandoned: release what it reserved. */
  failed: 'payment.failed',
  /** The provider moved a refund forward (processed / failed). */
  refundUpdated: 'payment.refund.updated',
  /** The provider settled or failed a transfer (seller payout). */
  transferUpdated: 'payment.transfer.updated',
} as const;

export type PaymentSucceeded = { payment: Lean<Payment> };
export type PaymentFailed = { payment: Lean<Payment>; reason: string };
export type RefundUpdated = { payment: Lean<Payment>; refund: PaymentRefund };
export type TransferUpdated = { reference: string; status: 'success' | 'failed' | 'reversed'; transferCode?: string; reason?: string };

export type PaymentView = {
  reference: string;
  status: Payment['status'];
  provider: string;
  amount: number;
  currency: string;
  method: CheckoutMethod;
  checkoutId: string;
  orderIds: string[];
  /** Send the buyer here to pay (the provider's hosted checkout). */
  authorizationUrl: string | null;
  /** For the provider's inline popup instead of a redirect. */
  accessCode: string | null;
  /** Paystack public key for the inline popup (null for the sandbox). */
  publicKey: string | null;
  paidAt: string | null;
  card: { brand?: string; last4?: string } | null;
  failureReason: string | null;
};

const CHANNELS: Record<CheckoutMethod, ChargeChannel[]> = {
  card: ['card'],
  transfer: ['bank_transfer'],
  ussd: ['ussd'],
  bank: ['bank'],
};

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly methods: PaymentMethodsService,
    private readonly events: EventBus,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // The sandbox delivers its simulated webhooks straight into the same handler.
    if (this.provider instanceof SandboxProvider) {
      this.provider.setEventSink((event) => this.handleEvent(event));
    }
  }

  get providerName(): string {
    return this.provider.name;
  }

  view(payment: Lean<Payment>): PaymentView {
    return {
      reference: payment.reference,
      status: payment.status,
      provider: payment.provider,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      checkoutId: payment.checkoutId,
      orderIds: payment.orderIds.map(String),
      authorizationUrl: payment.status === 'pending' ? (payment.authorizationUrl ?? null) : null,
      accessCode: payment.status === 'pending' ? (payment.accessCode ?? null) : null,
      publicKey: payment.provider === 'paystack' ? (this.config.payments.paystack.publicKey ?? null) : null,
      paidAt: payment.paidAt ? new Date(payment.paidAt).toISOString() : null,
      card: payment.card?.last4 ? { brand: payment.card.brand, last4: payment.card.last4 } : null,
      failureReason: payment.failureReason ?? null,
    };
  }

  /**
   * Asks the provider to charge the buyer for a checkout. With a saved card
   * the provider charges it directly; otherwise the buyer is sent to the
   * provider's checkout and the charge completes by verify or webhook.
   */
  async startCharge(input: {
    buyer: { id: string; email: string };
    orderIds: Types.ObjectId[];
    checkoutId: string;
    amount: number;
    method: CheckoutMethod;
    savedCardId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Lean<Payment>> {
    const reference = paymentReference();
    const created = await this.payments.create({
      reference,
      provider: this.provider.name,
      buyerId: new Types.ObjectId(input.buyer.id),
      orderIds: input.orderIds,
      checkoutId: input.checkoutId,
      amount: input.amount,
      method: input.method,
      status: 'pending',
    });
    const metadata = { checkoutId: input.checkoutId, buyerId: input.buyer.id, orderIds: input.orderIds.map(String), ...input.metadata };

    try {
      if (input.savedCardId) {
        const authorizationCode = await this.methods.authorizationFor(input.buyer.id, input.savedCardId);
        const status = await this.provider.chargeAuthorization({
          authorizationCode,
          email: input.buyer.email,
          amount: input.amount,
          reference,
          metadata,
        });
        return this.applyChargeStatus(created.toObject() as Lean<Payment>, status);
      }
      const init = await this.provider.initializeCharge({
        reference,
        amount: input.amount,
        email: input.buyer.email,
        callbackUrl: this.config.payments.callbackUrl,
        channels: CHANNELS[input.method],
        metadata,
      });
      const updated = await this.payments
        .findByIdAndUpdate(created._id, { $set: { authorizationUrl: init.authorizationUrl, accessCode: init.accessCode } }, { returnDocument: 'after' })
        .lean<Lean<Payment>>();
      return updated!;
    } catch (error) {
      await this.payments.updateOne(
        { _id: created._id, status: 'pending' },
        { $set: { status: 'failed', failureReason: (error as Error).message } },
      );
      const failed = await this.payments.findById(created._id).lean<Lean<Payment>>();
      await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: failed!, reason: 'provider-error' });
      throw error;
    }
  }

  async findByReference(reference: string): Promise<Lean<Payment> | null> {
    return this.payments.findOne({ reference }).lean<Lean<Payment>>();
  }

  async findByOrder(orderId: Types.ObjectId | string): Promise<Lean<Payment> | null> {
    return this.payments
      .findOne({ orderIds: new Types.ObjectId(String(orderId)), status: { $in: ['paid', 'pending'] } })
      .sort({ createdAt: -1 })
      .lean<Lean<Payment>>();
  }

  /** The buyer's return from checkout: confirms with the provider, then reports where things stand. */
  async verify(reference: string, buyerId?: string): Promise<Lean<Payment>> {
    const payment = await this.findByReference(reference);
    if (!payment || (buyerId && String(payment.buyerId) !== buyerId)) {
      throw Errors.notFound('We could not find that payment.', 'PAYMENT_NOT_FOUND');
    }
    if (payment.status === 'paid' && payment.fulfilledAt) return payment;
    if (payment.status !== 'pending' && payment.status !== 'paid') return payment;
    const status = await this.provider.verifyCharge(reference);
    return this.applyChargeStatus(payment, status);
  }

  /**
   * Moves a payment to what the provider reported. Safe to call repeatedly
   * and concurrently (webhook + verify): only one caller wins each
   * transition, and fulfilment re-runs until it has completed once.
   */
  private async applyChargeStatus(payment: Lean<Payment>, status: ChargeStatus): Promise<Lean<Payment>> {
    if (status.status === 'pending') return payment;

    if (status.status === 'success') {
      const currencyOk = (status.currency ?? 'NGN').toUpperCase() === payment.currency;
      const amountOk = toKobo(status.amount) === toKobo(payment.amount);
      if (!currencyOk || !amountOk) return this.flagMismatch(payment, status);

      await this.payments.updateOne(
        { _id: payment._id, status: 'pending' },
        {
          $set: {
            status: 'paid',
            paidAt: status.paidAt ?? new Date(),
            channel: status.channel,
            gatewayResponse: status.gatewayResponse,
            providerTransactionId: status.providerTransactionId,
            ...(status.authorization?.last4
              ? {
                  card: {
                    last4: status.authorization.last4,
                    brand: status.authorization.brand,
                    bank: status.authorization.bank,
                    expMonth: status.authorization.expMonth,
                    expYear: status.authorization.expYear,
                  },
                }
              : {}),
          },
          $push: { events: `paid:${new Date().toISOString()}` },
        },
      );
      const paid = await this.payments.findById(payment._id).lean<Lean<Payment>>();
      if (!paid || paid.status !== 'paid') return paid ?? payment;
      if (!paid.fulfilledAt) await this.fulfil(paid, status.authorization);
      return (await this.payments.findById(payment._id).lean<Lean<Payment>>())!;
    }

    const next = status.status === 'abandoned' ? 'abandoned' : 'failed';
    const changed = await this.payments.updateOne(
      { _id: payment._id, status: 'pending' },
      { $set: { status: next, failureReason: status.gatewayResponse ?? next }, $push: { events: `${next}:${new Date().toISOString()}` } },
    );
    const latest = (await this.payments.findById(payment._id).lean<Lean<Payment>>())!;
    if (changed.modifiedCount) {
      await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: latest, reason: next });
    }
    return latest;
  }

  /**
   * Runs fulfilment exactly once per charge. The webhook and the buyer's
   * verify call can arrive together; only the caller that claims the payment
   * fulfils it. A failed attempt releases its claim so a retry can take over.
   */
  private async fulfil(paid: Lean<Payment>, authorization?: ChargeStatus['authorization']): Promise<void> {
    const staleClaim = new Date(Date.now() - 5 * 60_000);
    const claimed = await this.payments
      .findOneAndUpdate(
        { _id: paid._id, status: 'paid', fulfilledAt: null, $or: [{ fulfillingAt: null }, { fulfillingAt: { $lt: staleClaim } }] },
        { $set: { fulfillingAt: new Date() } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Payment>>();
    if (!claimed) return;
    try {
      if (authorization?.reusable && authorization.authorizationCode) {
        await this.methods.saveCard(String(claimed.buyerId), this.provider.name, authorization).catch((error) => {
          this.logger.warn(`Could not save card: ${(error as Error).message}`);
        });
      }
      await this.events.emit<PaymentSucceeded>(PAYMENT_EVENTS.succeeded, { payment: claimed });
      await this.payments.updateOne({ _id: claimed._id }, { $set: { fulfilledAt: new Date() }, $unset: { fulfillingAt: 1 } });
    } catch (error) {
      await this.payments.updateOne({ _id: claimed._id, fulfilledAt: null }, { $unset: { fulfillingAt: 1 } });
      throw error;
    }
  }

  /** The provider says it collected something other than what we asked for: never fulfil, give it back. */
  private async flagMismatch(payment: Lean<Payment>, status: ChargeStatus): Promise<Lean<Payment>> {
    const changed = await this.payments.updateOne(
      { _id: payment._id, status: 'pending' },
      {
        $set: { status: 'failed', failureReason: 'amount-mismatch', reportedAmount: status.amount },
        $push: { events: `mismatch:${status.amount}:${status.currency}` },
      },
    );
    const latest = (await this.payments.findById(payment._id).lean<Lean<Payment>>())!;
    if (changed.modifiedCount) {
      this.logger.error(`Amount mismatch on ${payment.reference}: expected ${payment.amount}, provider reported ${status.amount} ${status.currency}`);
      if (status.amount > 0) {
        await this.provider
          .refund({ chargeReference: payment.reference, amount: status.amount, refundReference: refundReference(), reason: 'Payment amount did not match the order' })
          .catch((error) => this.logger.error(`Mismatch refund failed for ${payment.reference}: ${(error as Error).message}`));
      }
      await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: latest, reason: 'amount-mismatch' });
    }
    return latest;
  }

  /** Verifies the provider's signature and applies the event. Returns false when the signature is wrong. */
  async handleWebhook(providerName: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<boolean> {
    if (providerName !== this.provider.name) return false;
    if (!rawBody || !this.provider.verifyWebhookSignature(rawBody, headers)) return false;
    await this.handleEvent(this.provider.parseWebhook(body));
    return true;
  }

  async handleEvent(event: ProviderEvent): Promise<void> {
    switch (event.type) {
      case 'charge.success':
      case 'charge.failed': {
        const payment = await this.findByReference(event.reference);
        if (!payment) return; // Not one of ours.
        // Never trust the event body alone: confirm with the provider before giving value.
        const status = await this.provider.verifyCharge(event.reference);
        await this.applyChargeStatus(payment, status);
        return;
      }
      case 'refund.processed':
      case 'refund.failed':
      case 'refund.pending':
        await this.applyRefundEvent(event);
        return;
      case 'transfer.success':
      case 'transfer.failed':
      case 'transfer.reversed':
        await this.events.emit<TransferUpdated>(PAYMENT_EVENTS.transferUpdated, {
          reference: event.reference,
          status: event.type === 'transfer.success' ? 'success' : event.type === 'transfer.failed' ? 'failed' : 'reversed',
          transferCode: event.transferCode,
          reason: event.reason,
        });
        return;
      default:
        return;
    }
  }

  private async applyRefundEvent(event: Extract<ProviderEvent, { type: 'refund.processed' | 'refund.failed' | 'refund.pending' }>): Promise<void> {
    if (event.type === 'refund.pending') return;
    const match = event.providerRefundId
      ? { 'refunds.providerRefundId': event.providerRefundId }
      : event.refundReference
        ? { 'refunds.refundReference': event.refundReference }
        : null;
    if (!match) return;
    const status = event.type === 'refund.processed' ? 'processed' : 'failed';
    const updated = await this.payments
      .findOneAndUpdate(
        { ...match, refunds: { $elemMatch: { ...(event.providerRefundId ? { providerRefundId: event.providerRefundId } : { refundReference: event.refundReference }), status: 'pending' } } },
        { $set: { 'refunds.$.status': status, 'refunds.$.processedAt': new Date() } },
        { returnDocument: 'after' },
      )
      .lean<Lean<Payment>>();
    if (!updated) return;
    const refund = updated.refunds.find((entry) =>
      event.providerRefundId ? entry.providerRefundId === event.providerRefundId : entry.refundReference === event.refundReference,
    )!;
    await this.events.emit<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, { payment: updated, refund });
  }

  /**
   * Asks the provider to refund part of a charge back to the buyer's original
   * payment method. One refund per order; asking again returns the first.
   */
  async refundOrder(input: { orderId: Types.ObjectId | string; amount: number; reason: string }): Promise<PaymentRefund> {
    const orderId = new Types.ObjectId(String(input.orderId));
    const payment = await this.payments.findOne({ orderIds: orderId, status: 'paid' }).lean<Lean<Payment>>();
    if (!payment) throw Errors.conflict('There is no completed payment to refund for this order.', 'NOTHING_TO_REFUND');
    const existing = payment.refunds.find((entry) => String(entry.orderId) === String(orderId) && entry.status !== 'failed');
    if (existing) return existing;

    const committed = sumMoney(...payment.refunds.filter((entry) => entry.status !== 'failed').map((entry) => entry.amount));
    if (toKobo(committed) + toKobo(input.amount) > toKobo(payment.amount)) {
      throw Errors.conflict('That refund is larger than what is left on the payment.', 'REFUND_EXCEEDS_PAYMENT');
    }

    const reference = refundReference();
    const entry: PaymentRefund = {
      refundReference: reference,
      orderId,
      amount: input.amount,
      status: 'pending',
      reason: input.reason,
      requestedAt: new Date(),
    };
    const claimed = await this.payments.updateOne(
      { _id: payment._id, refunds: { $not: { $elemMatch: { orderId, status: { $ne: 'failed' } } } } },
      { $push: { refunds: entry } },
    );
    if (!claimed.modifiedCount) {
      const latest = await this.payments.findById(payment._id).lean<Lean<Payment>>();
      return latest!.refunds.find((row) => String(row.orderId) === String(orderId) && row.status !== 'failed')!;
    }

    try {
      const result = await this.provider.refund({ chargeReference: payment.reference, amount: input.amount, refundReference: reference, reason: input.reason });
      const applied = await this.payments
        .findOneAndUpdate(
          { _id: payment._id, 'refunds.refundReference': reference },
          {
            $set: {
              'refunds.$.providerRefundId': result.providerRefundId,
              ...(result.status !== 'pending' ? { 'refunds.$.status': result.status, 'refunds.$.processedAt': new Date() } : {}),
            },
          },
          { returnDocument: 'after' },
        )
        .lean<Lean<Payment>>();
      const refund = applied!.refunds.find((row) => row.refundReference === reference)!;
      if (result.status !== 'pending') await this.events.emit<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, { payment: applied!, refund });
      return refund;
    } catch (error) {
      const failed = await this.payments
        .findOneAndUpdate(
          { _id: payment._id, 'refunds.refundReference': reference },
          { $set: { 'refunds.$.status': 'failed', 'refunds.$.failureReason': (error as Error).message } },
          { returnDocument: 'after' },
        )
        .lean<Lean<Payment>>();
      const refund = failed!.refunds.find((row) => row.refundReference === reference)!;
      await this.events.emit<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, { payment: failed!, refund });
      return refund;
    }
  }

  /** Payments that have sat unpaid past the window: confirm with the provider, then let them lapse. */
  async expireStale(olderThan: Date): Promise<number> {
    const stale = await this.payments.find({ status: 'pending', createdAt: { $lt: olderThan } }).limit(200).lean<Lean<Payment>[]>();
    let expired = 0;
    for (const payment of stale) {
      const status = await this.provider.verifyCharge(payment.reference).catch(() => null);
      if (status && status.status !== 'pending') {
        await this.applyChargeStatus(payment, status);
        continue;
      }
      const changed = await this.payments.updateOne(
        { _id: payment._id, status: 'pending' },
        { $set: { status: 'abandoned', failureReason: 'expired' }, $push: { events: `expired:${new Date().toISOString()}` } },
      );
      if (changed.modifiedCount) {
        expired += 1;
        const latest = (await this.payments.findById(payment._id).lean<Lean<Payment>>())!;
        await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: latest, reason: 'expired' });
      }
    }
    return expired;
  }

  /** Re-runs fulfilment for charges that were paid but whose fulfilment crashed. */
  async retryUnfulfilled(): Promise<number> {
    const stuck = await this.payments
      .find({ status: 'paid', fulfilledAt: null, paidAt: { $lt: new Date(Date.now() - 60_000) } })
      .limit(100)
      .lean<Lean<Payment>[]>();
    for (const payment of stuck) {
      await this.fulfil(payment).catch((error) => this.logger.error(`Fulfilment retry failed for ${payment.reference}: ${(error as Error).message}`));
    }
    return stuck.length;
  }
}
