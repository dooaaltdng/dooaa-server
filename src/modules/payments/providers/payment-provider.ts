/**
 * The money boundary. DOOAA never holds or moves money itself: every debit
 * (charging a buyer) and every credit (paying a seller, refunding a buyer)
 * is executed by the provider behind this interface — Bachs. Our database
 * only records what the provider confirmed. Amounts here are in Naira.
 */

/** The rails a buyer may use on the hosted checkout. */
export type PaymentRail = 'card' | 'bank_transfer';

export type CheckoutInput = {
  /** Our payment reference; unique, and the idempotency key for the request. */
  reference: string;
  amount: number;
  customer: { email: string; name?: string; phone?: string };
  /** Where the buyer lands after paying, and after giving up. */
  successUrl: string;
  cancelUrl: string;
  rails: PaymentRail[];
  expiresInMinutes: number;
  metadata?: Record<string, string>;
};

export type CheckoutSession = {
  checkoutId: string;
  /** The hosted page to send the buyer to. */
  checkoutUrl: string;
  expiresAt?: Date;
};

/** Where a charge stands, as the provider reports it. */
export type ChargeStatus = {
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  /** What the charge was paid for (on success), in `currency`. */
  amount: number;
  currency: string;
  /** The provider's id for the charge; refunds are made against it. */
  chargeId?: string;
  paidAt?: Date;
  /** How the buyer paid ("card", "bank_transfer"). */
  channel?: string;
  /** The provider's own word for the outcome, kept for support. */
  gatewayResponse?: string;
  card?: { brand?: string; last4?: string };
};

export type RefundInput = {
  /** The provider's charge id. */
  chargeId: string;
  /** Our reference for this refund; the provider echoes it on webhooks. */
  reference: string;
  /** Omitted for "everything left on the charge". */
  amount?: number;
  reason?: string;
};

export type RefundResult = { providerRefundId: string; status: 'pending' | 'processed' | 'failed'; failureReason?: string };

export type Bank = { name: string; code: string; slug: string };

export type ResolvedAccount = { accountName: string; accountNumber: string; bankCode: string };

export type PayoutDestinationInput = { accountName: string; accountNumber: string; bankCode: string; label: string };

/** A bank account registered with the provider for payouts. New ones are reviewed before they can be used. */
export type PayoutDestination = { destinationId: string; usable: boolean; status: string };

export type PayoutInput = {
  destinationId: string;
  /** What the seller receives; the provider's fee is charged to DOOAA on top. */
  amount: number;
  /** Our payout reference; the provider echoes it on webhooks and uses it for idempotency. */
  reference: string;
};

export type PayoutResult = { payoutId: string; status: 'pending' | 'success' | 'failed'; failureReason?: string };

/** A webhook, reduced to what DOOAA acts on. `id` is the provider's event id (deliveries repeat). */
export type ProviderEvent =
  /** Something happened to a charge or its checkout: confirm with the provider, then apply. */
  | { id: string; type: 'charge.updated'; reference?: string; checkoutId?: string; chargeId?: string }
  | { id: string; type: 'refund.processed' | 'refund.failed' | 'refund.pending'; providerRefundId?: string; refundReference?: string; reason?: string }
  | { id: string; type: 'payout.success' | 'payout.failed'; reference: string; payoutId?: string; reason?: string }
  | { id: string; type: 'ignored'; name: string };

export interface PaymentProvider {
  readonly name: string;
  /** Opens a hosted checkout for one charge. */
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /** Where the charge behind a checkout stands. Never throws for a checkout that simply is not paid yet. */
  getCharge(checkoutId: string): Promise<ChargeStatus>;
  refund(input: RefundInput): Promise<RefundResult>;
  listBanks(): Promise<Bank[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount>;
  createPayoutDestination(input: PayoutDestinationInput): Promise<PayoutDestination>;
  getPayoutDestination(destinationId: string): Promise<PayoutDestination>;
  createPayout(input: PayoutInput): Promise<PayoutResult>;
  /** Checks the provider's signature over the raw webhook body. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(body: unknown): ProviderEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
