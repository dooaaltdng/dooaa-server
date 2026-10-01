/**
 * The money boundary. DOOAA never holds or moves money itself: every debit
 * (charging a buyer) and every credit (paying a seller, refunding a buyer)
 * is executed by the provider behind this interface. Our database only
 * records what the provider confirmed. Amounts here are in Naira; providers
 * convert to their own units.
 */

export type ChargeChannel = 'card' | 'bank_transfer' | 'ussd' | 'bank';

export type InitializeChargeInput = {
  reference: string;
  amount: number;
  email: string;
  callbackUrl: string;
  channels?: ChargeChannel[];
  metadata?: Record<string, unknown>;
};

export type InitializedCharge = {
  reference: string;
  /** Hosted checkout page to send the buyer to. */
  authorizationUrl: string;
  /** For the provider's inline/popup checkout. */
  accessCode: string;
};

export type CardAuthorization = {
  authorizationCode: string;
  signature?: string;
  last4?: string;
  brand?: string;
  bank?: string;
  expMonth?: string;
  expYear?: string;
  reusable: boolean;
  channel?: string;
};

export type ChargeStatus = {
  reference: string;
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  amount: number;
  currency: string;
  paidAt?: Date;
  channel?: string;
  gatewayResponse?: string;
  providerTransactionId?: string;
  customerEmail?: string;
  authorization?: CardAuthorization;
};

export type RefundInput = {
  /** The charge being refunded. */
  chargeReference: string;
  amount: number;
  /** Our reference for this refund, echoed back on webhooks where the provider supports it. */
  refundReference: string;
  reason?: string;
};

export type RefundResult = { providerRefundId: string; status: 'pending' | 'processed' | 'failed' };

export type Bank = { name: string; code: string; slug: string };

export type ResolvedAccount = { accountName: string; accountNumber: string; bankCode: string };

export type TransferInput = {
  amount: number;
  recipientCode: string;
  reference: string;
  reason: string;
};

export type TransferResult = { transferCode: string; status: 'pending' | 'success' | 'failed' | 'otp' };

export type ProviderEvent =
  | { type: 'charge.success' | 'charge.failed'; reference: string; charge: ChargeStatus }
  | { type: 'transfer.success' | 'transfer.failed' | 'transfer.reversed'; reference: string; transferCode?: string; reason?: string }
  | { type: 'refund.processed' | 'refund.failed' | 'refund.pending'; chargeReference: string; providerRefundId?: string; refundReference?: string; amount?: number }
  | { type: 'ignored'; name: string };

export interface PaymentProvider {
  readonly name: 'paystack' | 'sandbox';
  initializeCharge(input: InitializeChargeInput): Promise<InitializedCharge>;
  verifyCharge(reference: string): Promise<ChargeStatus>;
  /** Charges a saved card authorization (returning customers). */
  chargeAuthorization(input: { authorizationCode: string; email: string; amount: number; reference: string; metadata?: Record<string, unknown> }): Promise<ChargeStatus>;
  refund(input: RefundInput): Promise<RefundResult>;
  listBanks(): Promise<Bank[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount>;
  createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }>;
  initiateTransfer(input: TransferInput): Promise<TransferResult>;
  /** Checks the provider's signature over the raw webhook body. */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(body: unknown): ProviderEvent;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Events the provider raises are re-published on the bus under these names. */
export const PROVIDER_EVENT = 'provider.event';
