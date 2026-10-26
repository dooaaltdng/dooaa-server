import { Logger } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Errors } from '../../../common/api/app-error';
import { toKobo } from '../../../common/util/money';
import { slugify } from '../../../common/util/text';
import type {
  Bank,
  ChargeStatus,
  CheckoutInput,
  CheckoutSession,
  PaymentProvider,
  PaymentRail,
  PayoutDestination,
  PayoutDestinationInput,
  PayoutInput,
  PayoutResult,
  ProviderEvent,
  RefundInput,
  RefundResult,
  ResolvedAccount,
} from './payment-provider';
import { explain } from '../../../common/util/explain-error';

export type BachsOptions = {
  secretKey: string;
  /** The endpoint's signing secret (whsec_…), from the Bachs dashboard. */
  webhookSecret: string;
  baseUrl: string;
  /** Per attempt. */
  timeoutMs?: number;
};

/** How old a signed webhook may be before it is refused as a replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const RAIL_METHOD: Record<PaymentRail, string> = { card: 'NGN_CARD', bank_transfer: 'NGN_BANK_TRANSFER' };
const RETRY_DELAYS_MS = [400, 1_500];

/** Bachs answered with an error: `{ detail, error_code }`. */
export class BachsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

type CheckoutSessionResponse = {
  checkout_id: string;
  checkout_url?: string;
  status?: string;
  expires_at?: string;
  completed_at?: string | null;
  payment_method?: unknown;
  charge?: { payment_id?: string; status?: string; amount?: string | number; currency?: string } | null;
};

type PaymentResponse = { payment_id?: string; status?: string; amount?: string | number; amount_paid?: string | number; currency?: string };

/** Bachs amounts are decimal strings in major units ("1500.00"). */
export function toBachsAmount(naira: number): string {
  return (toKobo(naira) / 100).toFixed(2);
}

function fromBachsAmount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "NGN_CARD" → "card", "NGN_BANK_TRANSFER" → "bank_transfer". */
function channelOf(method: unknown): { channel?: string; card?: { brand?: string; last4?: string } } {
  const record = method && typeof method === 'object' ? (method as Record<string, unknown>) : undefined;
  const raw = typeof method === 'string' ? method : typeof record?.type === 'string' ? record.type : undefined;
  if (!raw) return {};
  const upper = raw.toUpperCase();
  const channel = upper.endsWith('_CARD') || upper === 'CARD' ? 'card' : upper.includes('BANK_TRANSFER') ? 'bank_transfer' : raw.toLowerCase();
  const brand = record?.card_brand ?? record?.brand;
  const last4 = record?.card_last4 ?? record?.last4;
  return {
    channel,
    card: typeof last4 === 'string' ? { brand: typeof brand === 'string' ? brand : undefined, last4 } : undefined,
  };
}

/**
 * Bachs (https://docs.bachs.io). Buyers pay on a hosted checkout session;
 * sellers are paid through payout destinations (bank accounts Bachs reviews
 * before first use); refunds go against the charge. Every write carries an
 * Idempotency-Key, so a retried request never charges, refunds or pays twice.
 * Webhooks are signed with HMAC-SHA256 over "{timestamp}.{raw body}" using
 * the endpoint's signing secret.
 */
export class BachsProvider implements PaymentProvider {
  readonly name = 'bachs';
  private readonly logger = new Logger('Bachs');

  constructor(private readonly options: BachsOptions) {}

  /* --- HTTP ------------------------------------------------------------------- */

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    // Reads are always safe to retry; writes only when an idempotency key makes them so.
    const retryable = method === 'GET' || Boolean(idempotencyKey);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${this.options.secretKey}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        response = await fetch(`${this.options.baseUrl}${path}`, init);
      } catch (error) {
        if (retryable && attempt < RETRY_DELAYS_MS.length) {
          await this.pause(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        this.logger.error(explain(`Could not reach Bachs (the payment provider) for ${method} ${path}`, error));
        throw Errors.badGateway('The payment provider is not responding. Please try again.', 'PAYMENT_PROVIDER_UNAVAILABLE');
      }

      const requestId = response.headers.get('x-request-id') ?? undefined;
      if ((response.status === 429 || response.status >= 500) && retryable && attempt < RETRY_DELAYS_MS.length) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.pause(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : RETRY_DELAYS_MS[attempt]);
        continue;
      }

      const payload = (await response.json().catch(() => undefined)) as (T & { detail?: unknown; error_code?: unknown }) | undefined;
      if (!response.ok) {
        const detail = typeof payload?.detail === 'string' ? payload.detail : `HTTP ${response.status}`;
        const code = typeof payload?.error_code === 'string' ? payload.error_code : `HTTP_${response.status}`;
        this.logger.warn(`Bachs (the payment provider) refused ${method} ${path}: ${detail}. Details: HTTP ${response.status} ${code}${requestId ? `, request ${requestId}` : ''}`);
        throw new BachsError(response.status, code, detail, requestId);
      }
      return payload as T;
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
  }

  /** Turns a Bachs refusal into the API's 502 with the provider's reason attached; anything else passes through. */
  private gatewayError(error: unknown, message: string, code = 'PAYMENT_PROVIDER_ERROR'): never {
    if (error instanceof BachsError) throw Errors.badGateway(message, code, { provider: error.message, providerCode: error.code });
    throw error;
  }

  /* --- Collections --------------------------------------------------------------- */

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    try {
      const session = await this.request<CheckoutSessionResponse>(
        'POST',
        '/v1/checkout-sessions',
        {
          pricing: { currency: 'NGN', amount: toBachsAmount(input.amount), price_type: 'fixed' },
          customer: { email: input.customer.email, name: input.customer.name, phone_number: input.customer.phone || undefined },
          reference: input.reference,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          payment_method_types: input.rails.map((rail) => RAIL_METHOD[rail]),
          expires_in_minutes: Math.min(1440, Math.max(1, Math.round(input.expiresInMinutes))),
          metadata: input.metadata,
        },
        `checkout-${input.reference}`,
      );
      if (!session.checkout_id || !session.checkout_url) throw new BachsError(502, 'INVALID_RESPONSE', 'Bachs returned no checkout');
      return { checkoutId: session.checkout_id, checkoutUrl: session.checkout_url, expiresAt: session.expires_at ? new Date(session.expires_at) : undefined };
    } catch (error) {
      return this.gatewayError(error, 'We could not start the payment. Please try again.');
    }
  }

  async getCharge(checkoutId: string): Promise<ChargeStatus> {
    let session: CheckoutSessionResponse;
    try {
      session = await this.request<CheckoutSessionResponse>('GET', `/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`);
    } catch (error) {
      if (error instanceof BachsError && error.status === 404) return { status: 'pending', amount: 0, currency: 'NGN' };
      return this.gatewayError(error, 'We could not confirm the payment with the provider.');
    }
    const charge = session.charge ?? undefined;
    const { channel, card } = channelOf(session.payment_method);
    const base = {
      currency: (charge?.currency ?? 'NGN').toUpperCase(),
      chargeId: charge?.payment_id,
      channel,
      card,
      paidAt: session.completed_at ? new Date(session.completed_at) : undefined,
    };
    const chargeStatus = charge?.status?.toLowerCase();
    if (!chargeStatus) {
      const sessionStatus = session.status?.toLowerCase();
      const lapsed = sessionStatus === 'expired' || sessionStatus === 'cancelled';
      return { ...base, status: lapsed ? 'abandoned' : 'pending', amount: 0, gatewayResponse: sessionStatus };
    }
    switch (chargeStatus) {
      case 'succeeded':
      case 'refunded':
      case 'partially_refunded':
        return { ...base, status: 'success', amount: fromBachsAmount(charge?.amount), gatewayResponse: chargeStatus };
      case 'accepted':
      case 'overpaid':
        // Paid, but not exactly what was asked: report what actually arrived so it is never fulfilled as if it matched.
        return { ...base, status: 'success', amount: await this.amountPaid(charge?.payment_id), gatewayResponse: chargeStatus };
      case 'failed':
      case 'cancelled':
      case 'auto_refunded':
        return { ...base, status: 'failed', amount: 0, gatewayResponse: chargeStatus };
      case 'expired':
        return { ...base, status: 'abandoned', amount: 0, gatewayResponse: chargeStatus };
      default:
        // created, processing, underpaid (a transfer may still be topped up).
        return { ...base, status: 'pending', amount: 0, gatewayResponse: chargeStatus };
    }
  }

  /** What the buyer actually paid on a charge; 0 when it cannot be told. */
  private async amountPaid(paymentId: string | undefined): Promise<number> {
    if (!paymentId) return 0;
    const payment = await this.request<PaymentResponse>('GET', `/v1/payments/${encodeURIComponent(paymentId)}`).catch(() => undefined);
    return fromBachsAmount(payment?.amount_paid);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const refund = await this.request<{ refund_id: string; status?: string }>(
        'POST',
        '/v1/refunds',
        {
          charge_id: input.chargeId,
          reference: input.reference,
          ...(input.amount !== undefined ? { amount: toBachsAmount(input.amount) } : {}),
          reason: input.reason?.slice(0, 500),
          idempotency_key: input.reference,
        },
        `refund-${input.reference}`,
      );
      const status = refund.status?.toLowerCase();
      return { providerRefundId: refund.refund_id, status: status === 'success' ? 'processed' : status === 'failed' ? 'failed' : 'pending' };
    } catch (error) {
      return this.gatewayError(error, 'The refund could not be started with the provider.', 'REFUND_REJECTED');
    }
  }

  /* --- Payouts -------------------------------------------------------------------- */

  async listBanks(): Promise<Bank[]> {
    try {
      const data = await this.request<{ banks?: { name: string; code: string }[] }>('GET', '/v1/reference/banks?country=NG');
      return (data.banks ?? []).map((bank) => ({ name: bank.name, code: bank.code, slug: slugify(bank.name) }));
    } catch (error) {
      return this.gatewayError(error, 'We could not load the list of banks.');
    }
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    let data: { resolved?: boolean; account_name?: string; account_number?: string };
    try {
      data = await this.request('POST', '/v1/misc/bank-accounts/resolve', { account_number: accountNumber, bank_code: bankCode, country: 'NG' });
    } catch (error) {
      if (error instanceof BachsError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw Errors.badRequest('We could not verify that account number with the bank.', 'ACCOUNT_NOT_RESOLVED');
      }
      return this.gatewayError(error, 'We could not verify that account right now.');
    }
    if (!data.resolved || !data.account_name) {
      throw Errors.badRequest('We could not verify that account number with the bank.', 'ACCOUNT_NOT_RESOLVED');
    }
    return { accountName: data.account_name, accountNumber: data.account_number ?? accountNumber, bankCode };
  }

  private toDestination(data: { id: string; status?: string; is_usable?: boolean }): PayoutDestination {
    return { destinationId: data.id, status: data.status ?? 'pending_review', usable: data.is_usable === true };
  }

  async createPayoutDestination(input: PayoutDestinationInput): Promise<PayoutDestination> {
    // The same account always maps to the same request, so registering it twice returns the first destination.
    const key = createHash('sha256').update(`${input.bankCode}:${input.accountNumber}`).digest('hex').slice(0, 40);
    try {
      const data = await this.request<{ id: string; status?: string; is_usable?: boolean }>(
        'POST',
        '/v1/payouts/destinations',
        { name: input.accountName, currency: 'NGN', label: input.label, account_number: input.accountNumber, bank_code: input.bankCode },
        `destination-${key}`,
      );
      return this.toDestination(data);
    } catch (error) {
      return this.gatewayError(error, 'We could not register that payout account.');
    }
  }

  async getPayoutDestination(destinationId: string): Promise<PayoutDestination> {
    try {
      return this.toDestination(await this.request('GET', `/v1/payouts/destinations/${encodeURIComponent(destinationId)}`));
    } catch (error) {
      return this.gatewayError(error, 'We could not check that payout account.');
    }
  }

  async createPayout(input: PayoutInput): Promise<PayoutResult> {
    try {
      const data = await this.request<{ id: string; status?: string; failure_reason?: string | null }>(
        'POST',
        '/v1/payouts',
        { destination: input.destinationId, amount: toBachsAmount(input.amount), reference: input.reference },
        `payout-${input.reference}`,
      );
      const status = data.status?.toLowerCase();
      return {
        payoutId: data.id,
        status: status === 'completed' ? 'success' : status === 'failed' ? 'failed' : 'pending',
        failureReason: data.failure_reason ?? undefined,
      };
    } catch (error) {
      return this.gatewayError(error, 'The payout could not be started with the provider.');
    }
  }

  /* --- Webhooks ------------------------------------------------------------------- */

  /**
   * Accepts the delivery when any signature it carries matches: the
   * X-Bachs-Signature-V2 list ("t=…,v1=…,v1=…", one v1 per valid secret)
   * or the single X-Bachs-Signature, and the timestamp is recent.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    if (!rawBody?.length || !this.options.webhookSecret) return false;
    const header = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const candidates: { timestamp: string; signature: string }[] = [];
    const v2 = header('x-bachs-signature-v2');
    if (v2) {
      const parts = v2.split(',').map((part) => part.trim().split('='));
      const timestamp = parts.find(([key]) => key === 't')?.[1];
      for (const [key, value] of parts) if (key === 'v1' && timestamp && value) candidates.push({ timestamp, signature: value });
    }
    const timestamp = header('x-bachs-timestamp');
    const v1 = header('x-bachs-signature');
    if (timestamp && v1) candidates.push({ timestamp, signature: v1 });

    const now = Math.floor(Date.now() / 1000);
    return candidates.some(({ timestamp: stamp, signature }) => {
      const seconds = Number(stamp);
      if (!Number.isFinite(seconds) || Math.abs(now - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;
      const expected = Buffer.from(this.sign(stamp, rawBody));
      const actual = Buffer.from(signature);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
  }

  /** HMAC-SHA256 hex of "{timestamp}.{raw body}" — exported for tests and local tooling. */
  sign(timestamp: string, rawBody: Buffer | string): string {
    return createHmac('sha256', this.options.webhookSecret).update(`${timestamp}.`).update(rawBody).digest('hex');
  }

  parseWebhook(body: unknown): ProviderEvent {
    const event = (body ?? {}) as { id?: unknown; type?: unknown; data?: Record<string, unknown> };
    const id = String(event.id ?? '');
    const type = String(event.type ?? '');
    const data = event.data ?? {};
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    switch (type) {
      case 'collection.succeeded':
      case 'collection.failed':
      case 'collection.underpaid':
      case 'checkout.completed':
      case 'checkout.expired':
        return {
          id,
          type: 'charge.updated',
          reference: text(data.reference),
          checkoutId: text(data.checkout_id) ?? (type.startsWith('checkout.') ? text(data.id) : undefined),
          chargeId: text(data.charge_id) ?? text(data.payment_id),
        };
      case 'refund.created':
      case 'refund.paid':
      case 'refund.failed':
        return {
          id,
          type: type === 'refund.paid' ? 'refund.processed' : type === 'refund.failed' ? 'refund.failed' : 'refund.pending',
          providerRefundId: text(data.refund_id) ?? text(data.id),
          refundReference: text(data.reference),
          reason: text(data.failure_reason) ?? text(data.reason),
        };
      case 'payout.paid':
      case 'payout.failed':
        return {
          id,
          type: type === 'payout.paid' ? 'payout.success' : 'payout.failed',
          reference: text(data.reference) ?? '',
          payoutId: text(data.id) ?? text(data.payout_id),
          reason: text(data.failure_reason),
        };
      default:
        return { id, type: 'ignored', name: type };
    }
  }
}
