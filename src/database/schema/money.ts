import type { CheckoutMethod, EarningStatus, PaymentStatus, PayoutAccountSource, PayoutStatus, RefundStatus } from '../../common/domain';
import { index, table } from '../database';
import type { PayoutDestination } from './values';

/*
 * DOOAA never holds money: charges, refunds and seller payouts are executed
 * by the payment provider. These collections record what the provider
 * confirmed and what DOOAA owes each seller.
 */

type Timestamps = { createdAt: Date; updatedAt: Date };

/** Our record of one charge. The provider is the source of truth; this mirrors what it confirmed. */
export type PaymentRow = Timestamps & {
  id: string;
  /** Our reference; also the idempotency key the provider sees. */
  reference: string;
  provider: string;
  /** The provider's id for the hosted checkout it opened for this charge. */
  providerReference: string | null;
  buyerId: string;
  checkoutId: string;
  amount: number;
  currency: string;
  method: CheckoutMethod;
  status: PaymentStatus;
  /** The provider's hosted checkout page. */
  checkoutUrl: string | null;
  paidAt: Date | null;
  /** Set once the orders this charge paid for have been fulfilled (escrow funded, sellers told). */
  fulfilledAt: Date | null;
  /** Claimed by the one caller fulfilling the charge (webhook and verify can race). */
  fulfillingAt: Date | null;
  /** How the buyer paid ("card", "bank_transfer"). */
  channel: string | null;
  gatewayResponse: string | null;
  /** The provider's id for the charge itself; refunds are made against it. */
  providerTransactionId: string | null;
  failureReason: string | null;
  /** Paid amount the provider reported, when it disagreed with ours. */
  reportedAmount: number | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cardBank: string | null;
  cardExpMonth: string | null;
  cardExpYear: string | null;
  /** A short audit trail of state changes ("paid:2026-10-17T…"). */
  events: string[];
};

export const payments = table<PaymentRow>()('payments', {
  key: 'id',
  defaults: () => ({ currency: 'NGN', status: 'pending' as PaymentStatus, events: [] as string[] }),
  nullable: [
    'providerReference',
    'checkoutUrl',
    'paidAt',
    'fulfilledAt',
    'fulfillingAt',
    'channel',
    'gatewayResponse',
    'providerTransactionId',
    'failureReason',
    'reportedAmount',
    'cardLast4',
    'cardBrand',
    'cardBank',
    'cardExpMonth',
    'cardExpYear',
  ],
  indexes: [
    index('payments_reference_key', { reference: 1 }, { unique: true }),
    index('payments_provider_reference_idx', { providerReference: 1 }),
    index('payments_buyer_idx', { buyerId: 1, createdAt: -1 }),
    index('payments_checkout_idx', { checkoutId: 1 }),
    index('payments_status_created_idx', { status: 1, createdAt: 1 }),
    index('payments_unfulfilled_idx', { status: 1, fulfilledAt: 1, paidAt: 1 }),
  ],
});

/** The orders one charge pays for (a cart checkout pays for one order per seller). */
export type PaymentOrderRow = { id: string; paymentId: string; orderId: string };

export const paymentOrders = table<PaymentOrderRow>()('payment_orders', {
  key: 'id',
  timestamps: false,
  indexes: [
    index('payment_orders_payment_order_key', { paymentId: 1, orderId: 1 }, { unique: true }),
    index('payment_orders_order_idx', { orderId: 1 }),
  ],
});

/** One refund the provider was asked to make against a charge. */
export type PaymentRefundRow = {
  id: string;
  paymentId: string;
  /** Our reference for the refund. */
  refundReference: string;
  orderId: string | null;
  amount: number;
  providerRefundId: string | null;
  status: RefundStatus;
  reason: string | null;
  requestedAt: Date;
  processedAt: Date | null;
  failureReason: string | null;
};

export const paymentRefunds = table<PaymentRefundRow>()('payment_refunds', {
  key: 'id',
  timestamps: false,
  defaults: () => ({ status: 'pending' as RefundStatus, requestedAt: new Date() }),
  nullable: ['orderId', 'providerRefundId', 'reason', 'processedAt', 'failureReason'],
  indexes: [
    index('payment_refunds_reference_key', { refundReference: 1 }, { unique: true }),
    index('payment_refunds_payment_idx', { paymentId: 1 }),
    index('payment_refunds_provider_id_idx', { providerRefundId: 1 }),
    /** At most one live (not failed) refund per order. */
    index(
      'payment_refunds_one_per_order_key',
      { paymentId: 1, orderId: 1 },
      { unique: true, partialFilterExpression: { status: { $in: ['pending', 'processed'] }, orderId: { $type: 'string' } } },
    ),
  ],
});

/**
 * Webhook events received from the payment provider, by the provider's event
 * id. Deliveries are at-least-once; an event that was processed is skipped
 * when it arrives again.
 */
export type ProviderEventRow = {
  id: string;
  provider: string;
  type: string;
  receivedAt: Date;
  /** Set once the event was applied; a failed attempt leaves it null so the retry runs again. */
  processedAt: Date | null;
};

export const providerEvents = table<ProviderEventRow>()('provider_events', {
  key: 'id',
  autoId: false,
  timestamps: false,
  defaults: () => ({ receivedAt: new Date() }),
  nullable: ['processedAt'],
  indexes: [index('provider_events_received_idx', { receivedAt: 1 })],
});

/**
 * A bank account a seller is paid out to. The bank confirms the account name
 * through the provider and the provider registers it as a payout
 * beneficiary; we keep only the last four digits and the beneficiary id.
 */
export type PayoutAccountRow = Timestamps & {
  id: string;
  userId: string;
  provider: string;
  bankCode: string;
  bankName: string;
  accountName: string;
  last4: string;
  /** sha256(bankCode:accountNumber), for de-duplication without storing the number. */
  fingerprint: string;
  /** The provider's id for this payout destination. */
  recipientCode: string;
  /** The provider approved the destination for payouts (new ones are reviewed first). */
  verified: boolean;
  primary: boolean;
  source: PayoutAccountSource;
};

export const payoutAccounts = table<PayoutAccountRow>()('payout_accounts', {
  key: 'id',
  defaults: () => ({ verified: false, primary: false, source: 'settings' as PayoutAccountSource }),
  indexes: [
    index('payout_accounts_user_fingerprint_key', { userId: 1, fingerprint: 1 }, { unique: true }),
    index('payout_accounts_user_idx', { userId: 1, createdAt: 1 }),
  ],
});

/**
 * A seller's balances, in integer kobo: bookkeeping of funds the provider
 * holds for the seller. Money only moves when the provider executes a payout.
 */
export type WalletRow = Timestamps & {
  sellerId: string;
  /** Released from escrow and not yet paid out. */
  availableKobo: number;
  /** Still held in escrow on open orders. */
  pendingKobo: number;
  /** Paid out to the seller's bank (payouts the provider confirmed). */
  withdrawnKobo: number;
};

export const wallets = table<WalletRow>()('wallets', {
  key: 'sellerId',
  autoId: false,
  defaults: () => ({ availableKobo: 0, pendingKobo: 0, withdrawnKobo: 0 }),
});

/** What one order owes its seller. One per order. */
export type EarningRow = Timestamps & {
  id: string;
  sellerId: string;
  orderId: string;
  orderNumber: string;
  product: string;
  amount: number;
  status: EarningStatus;
  fundedAt: Date;
  releasedAt: Date | null;
  cancelledAt: Date | null;
};

export const earnings = table<EarningRow>()('earnings', {
  key: 'id',
  defaults: () => ({ status: 'pending' as EarningStatus }),
  nullable: ['releasedAt', 'cancelledAt'],
  indexes: [index('earnings_order_key', { orderId: 1 }, { unique: true }), index('earnings_seller_idx', { sellerId: 1, status: 1, releasedAt: -1 })],
});

/** A withdrawal: one provider payout to the seller's bank. */
export type PayoutRow = Timestamps & {
  id: string;
  sellerId: string;
  /** Our payout reference; the provider echoes it on webhooks. */
  reference: string;
  amount: number;
  destination: PayoutDestination;
  status: PayoutStatus;
  /** The provider's id for the payout. */
  transferCode: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  automatic: boolean;
  attempts: number;
};

export const payouts = table<PayoutRow>()('payouts', {
  key: 'id',
  defaults: () => ({ status: 'processing' as PayoutStatus, automatic: false, attempts: 0 }),
  nullable: ['transferCode', 'completedAt', 'failedAt', 'failureReason'],
  indexes: [
    index('payouts_reference_key', { reference: 1 }, { unique: true }),
    index('payouts_seller_idx', { sellerId: 1, createdAt: -1 }),
    index('payouts_status_idx', { status: 1, createdAt: -1 }),
  ],
});
