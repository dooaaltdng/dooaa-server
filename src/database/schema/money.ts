import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { money as amount, primaryId, timestamps, timestamptz } from './columns';
import { checkoutMethod, earningStatus, paymentStatus, payoutAccountSource, payoutStatus, refundStatus } from './enums';
import { users } from './identity';
import { orders } from './trade';
import type { PayoutDestination } from './values';

/*
 * DOOAA never holds money: charges, refunds and seller payouts are executed
 * by the payment provider. These tables record what the provider confirmed
 * and what DOOAA owes each seller.
 */

/** Our record of one charge. The provider is the source of truth; this mirrors what it confirmed. */
export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    /** Our reference; also the idempotency key the provider sees. */
    reference: text().notNull(),
    provider: text().notNull(),
    /** The provider's id for the hosted checkout it opened for this charge. */
    providerReference: text(),
    buyerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    checkoutId: text().notNull(),
    amount: amount().notNull(),
    currency: char({ length: 3 }).notNull().default('NGN'),
    method: checkoutMethod().notNull(),
    status: paymentStatus().notNull().default('pending'),
    /** The provider's hosted checkout page. */
    checkoutUrl: text(),
    paidAt: timestamptz(),
    /** Set once the orders this charge paid for have been fulfilled (escrow funded, sellers told). */
    fulfilledAt: timestamptz(),
    /** Claimed by the one caller fulfilling the charge (webhook and verify can race). */
    fulfillingAt: timestamptz(),
    /** How the buyer paid ("card", "bank_transfer"). */
    channel: text(),
    gatewayResponse: text(),
    /** The provider's id for the charge itself; refunds are made against it. */
    providerTransactionId: text(),
    failureReason: text(),
    /** Paid amount the provider reported, when it disagreed with ours. */
    reportedAmount: amount(),
    cardLast4: text(),
    cardBrand: text(),
    cardBank: text(),
    cardExpMonth: text(),
    cardExpYear: text(),
    /** A short audit trail of state changes ("paid:2026-10-17T…"). */
    events: text().array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payments_reference_key').on(t.reference),
    index('payments_provider_reference_idx').on(t.providerReference),
    index('payments_buyer_idx').on(t.buyerId, t.createdAt.desc()),
    index('payments_checkout_idx').on(t.checkoutId),
    index('payments_status_created_idx').on(t.status, t.createdAt),
    index('payments_unfulfilled_idx').on(t.paidAt).where(sql`status = 'paid' and fulfilled_at is null`),
    check('payments_amount_positive', sql`${t.amount} > 0`),
  ],
);

/** The orders one charge pays for (a cart checkout pays for one order per seller). */
export const paymentOrders = pgTable(
  'payment_orders',
  {
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.paymentId, t.orderId] }), index('payment_orders_order_idx').on(t.orderId)],
);

/** One refund the provider was asked to make against a charge. */
export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: primaryId(),
    paymentId: uuid()
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    /** Our reference for the refund. */
    refundReference: text().notNull(),
    orderId: uuid().references(() => orders.id, { onDelete: 'set null' }),
    amount: amount().notNull(),
    providerRefundId: text(),
    status: refundStatus().notNull().default('pending'),
    reason: text(),
    requestedAt: timestamptz().notNull().defaultNow(),
    processedAt: timestamptz(),
    failureReason: text(),
  },
  (t) => [
    uniqueIndex('payment_refunds_reference_key').on(t.refundReference),
    index('payment_refunds_payment_idx').on(t.paymentId),
    index('payment_refunds_provider_id_idx').on(t.providerRefundId),
    /** At most one live (not failed) refund per order. */
    uniqueIndex('payment_refunds_one_per_order_key')
      .on(t.paymentId, t.orderId)
      .where(sql`status <> 'failed' and order_id is not null`),
    check('payment_refunds_amount_positive', sql`${t.amount} > 0`),
  ],
);

/**
 * Webhook events received from the payment provider, by the provider's event
 * id. Deliveries are at-least-once; an event that was processed is skipped
 * when it arrives again.
 */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    type: text().notNull(),
    receivedAt: timestamptz().notNull().defaultNow(),
    /** Set once the event was applied; a failed attempt leaves it null so the retry runs again. */
    processedAt: timestamptz(),
  },
  (t) => [index('provider_events_received_idx').on(t.receivedAt)],
);

/**
 * A bank account a seller is paid out to. The bank confirms the account name
 * through the provider and the provider registers it as a payout
 * beneficiary; we keep only the last four digits and the beneficiary id.
 */
export const payoutAccounts = pgTable(
  'payout_accounts',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    bankCode: text().notNull(),
    bankName: text().notNull(),
    accountName: text().notNull(),
    last4: text().notNull(),
    /** sha256(bankCode:accountNumber), for de-duplication without storing the number. */
    fingerprint: text().notNull(),
    /** The provider's id for this payout destination. */
    recipientCode: text().notNull(),
    /** The provider approved the destination for payouts (new ones are reviewed first). */
    verified: boolean().notNull().default(false),
    primary: boolean().notNull().default(false),
    source: payoutAccountSource().notNull().default('settings'),
    ...timestamps,
  },
  (t) => [uniqueIndex('payout_accounts_user_fingerprint_key').on(t.userId, t.fingerprint), index('payout_accounts_user_idx').on(t.userId, t.createdAt)],
);

/**
 * A seller's balances, in integer kobo: bookkeeping of funds the provider
 * holds for the seller. Money only moves when the provider executes a payout.
 */
export const wallets = pgTable(
  'wallets',
  {
    sellerId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Released from escrow and not yet paid out. */
    availableKobo: bigint({ mode: 'number' }).notNull().default(0),
    /** Still held in escrow on open orders. */
    pendingKobo: bigint({ mode: 'number' }).notNull().default(0),
    /** Paid out to the seller's bank (payouts the provider confirmed). */
    withdrawnKobo: bigint({ mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (t) => [check('wallets_available_nonnegative', sql`${t.availableKobo} >= 0`)],
);

/** What one order owes its seller. One per order. */
export const earnings = pgTable(
  'earnings',
  {
    id: primaryId(),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    orderNumber: text().notNull(),
    product: text().notNull(),
    amount: amount().notNull(),
    status: earningStatus().notNull().default('pending'),
    fundedAt: timestamptz().notNull(),
    releasedAt: timestamptz(),
    cancelledAt: timestamptz(),
    ...timestamps,
  },
  (t) => [uniqueIndex('earnings_order_key').on(t.orderId), index('earnings_seller_idx').on(t.sellerId, t.status, t.releasedAt.desc())],
);

/** A withdrawal: one provider payout to the seller's bank. */
export const payouts = pgTable(
  'payouts',
  {
    id: primaryId(),
    sellerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Our payout reference; the provider echoes it on webhooks. */
    reference: text().notNull(),
    amount: amount().notNull(),
    destination: jsonb().$type<PayoutDestination>().notNull(),
    status: payoutStatus().notNull().default('processing'),
    /** The provider's id for the payout. */
    transferCode: text(),
    completedAt: timestamptz(),
    failedAt: timestamptz(),
    failureReason: text(),
    automatic: boolean().notNull().default(false),
    attempts: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payouts_reference_key').on(t.reference),
    index('payouts_seller_idx').on(t.sellerId, t.createdAt.desc()),
    index('payouts_status_idx').on(t.status, t.createdAt.desc()),
    check('payouts_amount_positive', sql`${t.amount} > 0`),
  ],
);
