import { Inject, Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import { EventBus } from '../../common/events/event-bus';
import type { CheckoutMethod, PaymentStatus } from '../../common/domain';
import { paymentReference, refundReference } from '../../common/util/ids';
import { formatNaira, sumMoney, toKobo } from '../../common/util/money';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, isUniqueViolation, type Database, type Patch, type Where } from '../../database/database';
import { paymentOrders, paymentRefunds, payments, providerEvents, type PaymentRow } from '../../database/schema';
import {
  PAYMENT_PROVIDER,
  type ChargeStatus,
  type PaymentProvider,
  type PaymentRail,
  type ProviderEvent,
} from './providers/payment-provider';

export const PAYMENT_EVENTS = {
  /** A charge was confirmed by the provider: fulfil the orders it paid for. */
  succeeded: 'payment.succeeded',
  /** A charge failed or was abandoned: release what it reserved. */
  failed: 'payment.failed',
  /** The provider moved a refund forward (processed / failed). */
  refundUpdated: 'payment.refund.updated',
  /** The provider settled or failed a seller payout. */
  payoutSettled: 'payment.payout.settled',
} as const;

export type PaymentRecord = typeof payments.$inferSelect;
export type PaymentRefund = typeof paymentRefunds.$inferSelect;
/** A charge and the orders it pays for. */
export type Payment = PaymentRecord & { orderIds: string[] };

export type PaymentSucceeded = { payment: Payment };
export type PaymentFailed = { payment: Payment; reason: string };
export type RefundUpdated = { payment: Payment; refund: PaymentRefund };
export type PayoutSettled = { reference: string; status: 'success' | 'failed'; payoutId?: string; reason?: string };

export type PaymentView = {
  reference: string;
  status: PaymentStatus;
  provider: string;
  amount: number;
  currency: string;
  method: CheckoutMethod;
  checkoutId: string;
  orderIds: string[];
  /** Send the buyer here to pay (the provider's hosted checkout); null once the payment has an outcome. */
  authorizationUrl: string | null;
  paidAt: string | null;
  card: { brand?: string; last4?: string } | null;
  failureReason: string | null;
};

/** The rails each checkout method opens on the provider's page. */
const RAILS: Record<CheckoutMethod, PaymentRail[]> = {
  card: ['card'],
  transfer: ['bank_transfer'],
};

/** Bachs will not open a Naira checkout for less. */
export const MINIMUM_CHARGE = 100;

/** A fulfilment claim older than this is assumed dead (crashed instance) and may be taken over. */
const STALE_CLAIM_MS = 5 * 60_000;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly events: EventBus,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  view(payment: Payment): PaymentView {
    return {
      reference: payment.reference,
      status: payment.status,
      provider: payment.provider,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      checkoutId: payment.checkoutId,
      orderIds: payment.orderIds,
      authorizationUrl: payment.status === 'pending' ? payment.checkoutUrl : null,
      paidAt: payment.paidAt?.toISOString() ?? null,
      card: payment.cardLast4 ? { brand: payment.cardBrand ?? undefined, last4: payment.cardLast4 } : null,
      failureReason: payment.failureReason,
    };
  }

  /* --- Reads --------------------------------------------------------------------- */

  private async load(where: Where<PaymentRow>): Promise<Payment | null> {
    const row = await this.db.findOne(payments, where, { sort: { createdAt: -1 } });
    if (!row) return null;
    const links = await this.db.find(paymentOrders, { paymentId: row.id });
    return { ...row, orderIds: links.map((link) => link.orderId) };
  }

  private async reload(id: string): Promise<Payment> {
    return (await this.load({ id }))!;
  }

  async findByReference(reference: string): Promise<Payment | null> {
    return this.load({ reference });
  }

  /** The live (paid or still pending) charge for an order. */
  async findByOrder(orderId: string): Promise<Payment | null> {
    return this.load({ id: { $in: await this.db.distinct(paymentOrders, 'paymentId', { orderId }) }, status: { $in: ['paid', 'pending'] } });
  }

  /* --- Charging ------------------------------------------------------------------ */

  /**
   * Opens the provider's hosted checkout for a checkout's orders. The buyer
   * pays there; the charge completes by verify or webhook.
   */
  async startCharge(input: {
    buyer: { id: string; email: string; name?: string; phone?: string };
    orderIds: string[];
    checkoutId: string;
    amount: number;
    method: CheckoutMethod;
    expiresInMinutes: number;
  }): Promise<Payment> {
    if (toKobo(input.amount) < toKobo(MINIMUM_CHARGE)) {
      throw Errors.badRequest(`The minimum payment is ${formatNaira(MINIMUM_CHARGE)}.`, 'AMOUNT_TOO_SMALL');
    }
    const reference = paymentReference();
    const created = await this.db.transaction(async (tx) => {
      const row = await tx.insert(payments, {
          reference,
          provider: this.provider.name,
          buyerId: input.buyer.id,
          checkoutId: input.checkoutId,
          amount: input.amount,
          method: input.method,
          status: 'pending',
        });
      await tx.insertMany(
        paymentOrders,
        input.orderIds.map((orderId) => ({ paymentId: row.id, orderId })),
      );
      return row;
    });

    try {
      const callback = new URL(this.config.payments.callbackUrl);
      callback.searchParams.set('reference', reference);
      const cancelled = new URL(callback);
      cancelled.searchParams.set('cancelled', '1');
      const session = await this.provider.createCheckout({
        reference,
        amount: input.amount,
        customer: { email: input.buyer.email, name: input.buyer.name, phone: input.buyer.phone },
        successUrl: callback.toString(),
        cancelUrl: cancelled.toString(),
        rails: RAILS[input.method],
        expiresInMinutes: input.expiresInMinutes,
        metadata: { checkoutId: input.checkoutId, buyerId: input.buyer.id, orders: input.orderIds.join(',') },
      });
      await this.db.update(payments, { id: created.id }, { providerReference: session.checkoutId, checkoutUrl: session.checkoutUrl });
      return this.reload(created.id);
    } catch (error) {
      await this.db.update(payments, { id: created.id, status: 'pending' }, this.withEvent('failed', { status: 'failed', failureReason: (error as Error).message }));
      await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: await this.reload(created.id), reason: 'provider-error' });
      throw error;
    }
  }

  /** The buyer's return from checkout: confirms with the provider, then reports where things stand. */
  async verify(reference: string, buyerId?: string): Promise<Payment> {
    // Providers append their own query to the return URL; anything after our reference is not part of it.
    const clean = reference.split(/[?&#]/)[0].trim();
    const payment = clean ? await this.findByReference(clean) : null;
    if (!payment || (buyerId && payment.buyerId !== buyerId)) {
      throw Errors.notFound('We could not find that payment.', 'PAYMENT_NOT_FOUND');
    }
    if (payment.status === 'paid' && payment.fulfilledAt) return payment;
    if (payment.status !== 'pending' && payment.status !== 'paid') return payment;
    if (!payment.providerReference) return payment;
    return this.applyChargeStatus(payment, await this.provider.getCharge(payment.providerReference));
  }

  /** A change that also appends to the payment's audit trail. */
  private withEvent(label: string, set: Partial<PaymentRow>): Patch<PaymentRow> {
    return { $set: set, $push: { events: `${label}:${new Date().toISOString()}` } };
  }

  /**
   * Moves a payment to what the provider reported. Safe to call repeatedly
   * and concurrently (webhook + verify): only one caller wins each
   * transition, and fulfilment re-runs until it has completed once.
   */
  private async applyChargeStatus(payment: Payment, status: ChargeStatus): Promise<Payment> {
    if (status.status === 'pending') return payment;

    if (status.status === 'success') {
      const currencyOk = (status.currency ?? 'NGN').toUpperCase() === payment.currency;
      const amountOk = toKobo(status.amount) === toKobo(payment.amount);
      if (!currencyOk || !amountOk) return this.flagMismatch(payment, status);

      await this.db.update(
        payments,
        { id: payment.id, status: 'pending' },
        this.withEvent('paid', {
          status: 'paid',
          paidAt: status.paidAt ?? new Date(),
          channel: status.channel ?? null,
          gatewayResponse: status.gatewayResponse ?? null,
          providerTransactionId: status.chargeId ?? null,
          cardBrand: status.card?.brand ?? null,
          cardLast4: status.card?.last4 ?? null,
        }),
      );
      const paid = await this.reload(payment.id);
      if (paid.status !== 'paid') return paid;
      if (!paid.fulfilledAt) await this.fulfil(paid);
      return this.reload(payment.id);
    }

    const next = status.status === 'abandoned' ? 'abandoned' : 'failed';
    const changed = await this.db.update(payments, { id: payment.id, status: 'pending' }, this.withEvent(next, { status: next, failureReason: status.gatewayResponse ?? next }));
    const latest = await this.reload(payment.id);
    if (changed) await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: latest, reason: next });
    return latest;
  }

  /**
   * Runs fulfilment exactly once per charge. The webhook and the buyer's
   * verify call can arrive together; only the caller that claims the payment
   * fulfils it. A failed attempt releases its claim so a retry can take over.
   */
  private async fulfil(paid: Payment): Promise<void> {
    const staleClaim = new Date(Date.now() - STALE_CLAIM_MS);
    const claimed = await this.db.update(
      payments,
      { id: paid.id, status: 'paid', fulfilledAt: null, $or: [{ fulfillingAt: null }, { fulfillingAt: { $lt: staleClaim } }] },
      { fulfillingAt: new Date() },
    );
    if (!claimed) return;
    try {
      await this.events.emit<PaymentSucceeded>(PAYMENT_EVENTS.succeeded, { payment: await this.reload(paid.id) });
      await this.db.update(payments, { id: paid.id }, { fulfilledAt: new Date(), fulfillingAt: null });
    } catch (error) {
      await this.db.update(payments, { id: paid.id, fulfilledAt: null }, { fulfillingAt: null });
      throw error;
    }
  }

  /** The provider says it collected something other than what we asked for: never fulfil, give it back. */
  private async flagMismatch(payment: Payment, status: ChargeStatus): Promise<Payment> {
    const changed = await this.db.update(
      payments,
      { id: payment.id, status: 'pending' },
      this.withEvent(`mismatch:${status.amount}:${status.currency}`, {
        status: 'failed',
        failureReason: 'amount-mismatch',
        reportedAmount: status.amount,
        providerTransactionId: status.chargeId ?? null,
      }),
    );
    const latest = await this.reload(payment.id);
    if (changed) {
      this.logger.error(`Amount mismatch on ${payment.reference}: expected ${payment.amount}, provider reported ${status.amount} ${status.currency}`);
      if (status.amount > 0 && status.chargeId) {
        // Everything that was collected goes back: the refund takes the whole remaining balance of the charge.
        const reference = refundReference();
        await this.db.insert(paymentRefunds, { paymentId: payment.id, refundReference: reference, amount: status.amount, reason: 'Payment amount did not match the order' });
        await this.provider
          .refund({ chargeId: status.chargeId, reference, reason: 'Payment amount did not match the order' })
          .then((result) => this.db.update(paymentRefunds, { refundReference: reference }, { providerRefundId: result.providerRefundId }))
          .catch(async (error: Error) => {
            this.logger.error(`Mismatch refund failed for ${payment.reference}: ${error.message}`);
            await this.db.update(paymentRefunds, { refundReference: reference }, { status: 'failed', failureReason: error.message });
          });
      }
      await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: latest, reason: 'amount-mismatch' });
    }
    return latest;
  }

  /* --- Webhooks ------------------------------------------------------------------ */

  /**
   * Verifies the provider's signature, then applies the event once: a
   * delivery the provider repeats after it was processed is acknowledged
   * and skipped. Returns false when the signature is wrong.
   */
  async handleWebhook(providerName: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<boolean> {
    if (providerName !== this.provider.name) return false;
    if (!rawBody || !this.provider.verifyWebhook(rawBody, headers)) return false;
    const event = this.provider.parseWebhook(body);
    if (event.id) {
      await this.db.insertIgnoringDuplicates(providerEvents, [{ id: event.id, provider: this.provider.name, type: event.type === 'ignored' ? event.name : event.type }]);
      const seen = await this.db.findOne(providerEvents, { id: event.id });
      if (seen?.processedAt) return true;
    }
    await this.handleEvent(event);
    if (event.id) await this.db.update(providerEvents, { id: event.id }, { processedAt: new Date() });
    return true;
  }

  async handleEvent(event: ProviderEvent): Promise<void> {
    switch (event.type) {
      case 'charge.updated': {
        const matches: Where<PaymentRow>[] = [];
        if (event.reference) matches.push({ reference: event.reference });
        if (event.checkoutId) matches.push({ providerReference: event.checkoutId });
        if (event.chargeId) matches.push({ providerTransactionId: event.chargeId });
        const payment = matches.length ? await this.load({ $or: matches }) : null;
        if (!payment?.providerReference) return; // Not one of ours.
        // Never trust the event body alone: confirm with the provider before giving value.
        await this.applyChargeStatus(payment, await this.provider.getCharge(payment.providerReference));
        return;
      }
      case 'refund.processed':
      case 'refund.failed':
      case 'refund.pending':
        await this.applyRefundEvent(event);
        return;
      case 'payout.success':
      case 'payout.failed':
        await this.events.emit<PayoutSettled>(PAYMENT_EVENTS.payoutSettled, {
          reference: event.reference,
          status: event.type === 'payout.success' ? 'success' : 'failed',
          payoutId: event.payoutId,
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
      ? { providerRefundId: event.providerRefundId }
      : event.refundReference
        ? { refundReference: event.refundReference }
        : null;
    if (!match) return;
    const status = event.type === 'refund.processed' ? 'processed' : 'failed';
    const refund = await this.db.update(
      paymentRefunds,
      { ...match, status: 'pending' },
      { status, processedAt: new Date(), ...(status === 'failed' ? { failureReason: event.reason ?? 'Refund failed' } : {}) },
    );
    if (!refund) return;
    await this.events.emit<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, { payment: await this.reload(refund.paymentId), refund });
  }

  /* --- Refunds ------------------------------------------------------------------- */

  /**
   * Asks the provider to refund an order's share of a charge back to the
   * buyer's original payment method. One refund per order; asking again
   * returns the first. Bachs accepts one refund per charge, so a second
   * order refunded from the same multi-seller checkout is refused by the
   * provider and recorded as failed for the console to settle by hand.
   */
  async refundOrder(input: { orderId: string; amount: number; reason: string }): Promise<PaymentRefund> {
    const payment = await this.load({ id: { $in: await this.db.distinct(paymentOrders, 'paymentId', { orderId: input.orderId }) }, status: 'paid' });
    if (!payment) throw Errors.conflict('There is no completed payment to refund for this order.', 'NOTHING_TO_REFUND');

    const liveRefunds = await this.db.find(paymentRefunds, { paymentId: payment.id, status: { $ne: 'failed' } });
    const existing = liveRefunds.find((refund) => refund.orderId === input.orderId);
    if (existing) return existing;
    const committed = sumMoney(...liveRefunds.map((refund) => refund.amount));
    if (toKobo(committed) + toKobo(input.amount) > toKobo(payment.amount)) {
      throw Errors.conflict('That refund is larger than what is left on the payment.', 'REFUND_EXCEEDS_PAYMENT');
    }

    const reference = refundReference();
    let refund: PaymentRefund;
    try {
      refund = await this.db.insert(paymentRefunds, {
        paymentId: payment.id,
        refundReference: reference,
        orderId: input.orderId,
        amount: input.amount,
        status: 'pending',
        reason: input.reason,
      });
    } catch (error) {
      // Two callers raced; the partial unique index let one refund through. Return that one.
      if (!isUniqueViolation(error, 'payment_refunds_one_per_order_key')) throw error;
      return (await this.db.findOne(paymentRefunds, { paymentId: payment.id, orderId: input.orderId, status: { $ne: 'failed' } }))!;
    }

    try {
      const chargeId = payment.providerTransactionId ?? (payment.providerReference ? (await this.provider.getCharge(payment.providerReference)).chargeId : undefined);
      if (!chargeId) throw Errors.badGateway('The provider has no charge to refund for this payment.', 'REFUND_REJECTED');
      const result = await this.provider.refund({ chargeId, reference, amount: input.amount, reason: input.reason });
      const applied = (await this.db.update(
        paymentRefunds,
        { id: refund.id },
        {
          providerRefundId: result.providerRefundId,
          ...(result.status !== 'pending' ? { status: result.status, processedAt: new Date(), failureReason: result.failureReason ?? null } : {}),
        },
      ))!;
      if (applied.status !== 'pending') await this.events.emit<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, { payment, refund: applied });
      return applied;
    } catch (error) {
      const failed = (await this.db.update(paymentRefunds, { id: refund.id }, { status: 'failed', failureReason: this.refundFailure(error) }))!;
      await this.events.emit<RefundUpdated>(PAYMENT_EVENTS.refundUpdated, { payment, refund: failed });
      return failed;
    }
  }

  private refundFailure(error: unknown): string {
    const details = (error as { getResponse?: () => { details?: { provider?: string } } }).getResponse?.().details;
    return details?.provider ? `${(error as Error).message} (${details.provider})` : (error as Error).message;
  }

  /* --- Background work ------------------------------------------------------------- */

  /** Payments that have sat unpaid past the window: confirm with the provider, then let them lapse. */
  async expireStale(olderThan: Date): Promise<number> {
    const stale = await this.db.find(payments, { status: 'pending', createdAt: { $lt: olderThan } }, { limit: 200 });
    let expired = 0;
    for (const { id } of stale) {
      const payment = await this.reload(id);
      const status = payment.providerReference ? await this.provider.getCharge(payment.providerReference).catch(() => null) : null;
      if (status && status.status !== 'pending') {
        await this.applyChargeStatus(payment, status);
        continue;
      }
      const changed = await this.db.update(payments, { id, status: 'pending' }, this.withEvent('expired', { status: 'abandoned', failureReason: 'expired' }));
      if (changed) {
        expired += 1;
        await this.events.emit<PaymentFailed>(PAYMENT_EVENTS.failed, { payment: await this.reload(id), reason: 'expired' });
      }
    }
    return expired;
  }

  /** Re-runs fulfilment for charges that were paid but whose fulfilment crashed. */
  async retryUnfulfilled(): Promise<number> {
    const stuck = await this.db.find(payments, { status: 'paid', fulfilledAt: null, paidAt: { $lt: new Date(Date.now() - 60_000) } }, { limit: 100 });
    for (const row of stuck) {
      await this.fulfil(await this.reload(row.id)).catch((error: Error) => this.logger.error(`Fulfilment retry failed for ${row.reference}: ${error.message}`));
    }
    return stuck.length;
  }
}
