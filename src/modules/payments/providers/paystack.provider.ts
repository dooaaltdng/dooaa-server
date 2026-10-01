import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Errors } from '../../../common/api/app-error';
import { fromKobo, toKobo } from '../../../common/util/money';
import type {
  Bank,
  CardAuthorization,
  ChargeStatus,
  InitializeChargeInput,
  InitializedCharge,
  PaymentProvider,
  ProviderEvent,
  RefundInput,
  RefundResult,
  ResolvedAccount,
  TransferInput,
  TransferResult,
} from './payment-provider';

type PaystackEnvelope<T> = { status: boolean; message: string; data: T };

type PaystackTransaction = {
  id: number;
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  paidAt?: string | null;
  channel?: string;
  gateway_response?: string;
  customer?: { email?: string };
  authorization?: {
    authorization_code?: string;
    signature?: string;
    last4?: string;
    card_type?: string;
    brand?: string;
    bank?: string;
    exp_month?: string;
    exp_year?: string;
    reusable?: boolean;
    channel?: string;
  };
};

export class PaystackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function mapStatus(status: string): ChargeStatus['status'] {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'reversed') return 'failed';
  if (status === 'abandoned') return 'abandoned';
  return 'pending';
}

export function toChargeStatus(data: PaystackTransaction): ChargeStatus {
  const auth = data.authorization;
  const authorization: CardAuthorization | undefined = auth?.authorization_code
    ? {
        authorizationCode: auth.authorization_code,
        signature: auth.signature,
        last4: auth.last4,
        brand: (auth.brand ?? auth.card_type)?.trim(),
        bank: auth.bank,
        expMonth: auth.exp_month,
        expYear: auth.exp_year,
        reusable: Boolean(auth.reusable),
        channel: auth.channel,
      }
    : undefined;
  const paid = data.paid_at ?? data.paidAt;
  return {
    reference: data.reference,
    status: mapStatus(data.status),
    amount: fromKobo(data.amount),
    currency: data.currency,
    paidAt: paid ? new Date(paid) : undefined,
    channel: data.channel,
    gatewayResponse: data.gateway_response,
    providerTransactionId: data.id !== undefined ? String(data.id) : undefined,
    customerEmail: data.customer?.email,
    authorization,
  };
}

/**
 * Paystack (https://paystack.com/docs/api). Collections through the
 * transaction API, seller payouts through Transfers to registered
 * recipients, refunds through the Refund API. Webhooks are signed with an
 * HMAC-SHA512 of the raw body using the secret key.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;
  private readonly logger = new Logger('Paystack');

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = 'https://api.paystack.co',
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      this.logger.error(`${method} ${path} failed: ${(error as Error).message}`);
      throw Errors.badGateway('The payment provider is not responding. Please try again.', 'PAYMENT_PROVIDER_UNAVAILABLE');
    }
    let payload: PaystackEnvelope<T> | undefined;
    try {
      payload = (await response.json()) as PaystackEnvelope<T>;
    } catch {
      payload = undefined;
    }
    if (!response.ok || !payload?.status) {
      const message = payload?.message ?? `HTTP ${response.status}`;
      this.logger.warn(`${method} ${path} → ${response.status}: ${message}`);
      throw new PaystackError(response.status, message);
    }
    return payload.data;
  }

  private gatewayError(error: unknown, fallback: string): never {
    if (error instanceof PaystackError) {
      throw Errors.badGateway(fallback, 'PAYMENT_PROVIDER_ERROR', { provider: error.message });
    }
    throw error;
  }

  async initializeCharge(input: InitializeChargeInput): Promise<InitializedCharge> {
    try {
      const data = await this.call<{ authorization_url: string; access_code: string; reference: string }>('POST', '/transaction/initialize', {
        email: input.email,
        amount: toKobo(input.amount),
        currency: 'NGN',
        reference: input.reference,
        callback_url: input.callbackUrl,
        channels: input.channels,
        metadata: input.metadata,
      });
      return { reference: data.reference, authorizationUrl: data.authorization_url, accessCode: data.access_code };
    } catch (error) {
      return this.gatewayError(error, 'We could not start the payment. Please try again.');
    }
  }

  async verifyCharge(reference: string): Promise<ChargeStatus> {
    try {
      return toChargeStatus(await this.call<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`));
    } catch (error) {
      if (error instanceof PaystackError && error.status === 404) {
        return { reference, status: 'pending', amount: 0, currency: 'NGN' };
      }
      return this.gatewayError(error, 'We could not confirm the payment with the provider.');
    }
  }

  async chargeAuthorization(input: { authorizationCode: string; email: string; amount: number; reference: string; metadata?: Record<string, unknown> }): Promise<ChargeStatus> {
    try {
      const data = await this.call<PaystackTransaction>('POST', '/transaction/charge_authorization', {
        authorization_code: input.authorizationCode,
        email: input.email,
        amount: toKobo(input.amount),
        currency: 'NGN',
        reference: input.reference,
        metadata: input.metadata,
      });
      return toChargeStatus(data);
    } catch (error) {
      return this.gatewayError(error, 'Your saved card could not be charged. Try paying another way.');
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const data = await this.call<{ id: number; status: string }>('POST', '/refund', {
        transaction: input.chargeReference,
        amount: toKobo(input.amount),
        currency: 'NGN',
        customer_note: input.reason,
        merchant_note: `DOOAA refund ${input.refundReference}`,
      });
      const status = data.status === 'processed' ? 'processed' : data.status === 'failed' ? 'failed' : 'pending';
      return { providerRefundId: String(data.id), status };
    } catch (error) {
      return this.gatewayError(error, 'The refund could not be started with the provider.');
    }
  }

  async listBanks(): Promise<Bank[]> {
    try {
      const data = await this.call<Array<{ name: string; code: string; slug: string; active?: boolean }>>('GET', '/bank?country=nigeria&perPage=200');
      return data.filter((bank) => bank.active !== false).map((bank) => ({ name: bank.name, code: bank.code, slug: bank.slug }));
    } catch (error) {
      return this.gatewayError(error, 'We could not load the list of banks.');
    }
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    try {
      const data = await this.call<{ account_name: string; account_number: string }>(
        'GET',
        `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      );
      return { accountName: data.account_name, accountNumber: data.account_number, bankCode };
    } catch (error) {
      if (error instanceof PaystackError && error.status >= 400 && error.status < 500) {
        throw Errors.badRequest('We could not verify that account number with the bank.', 'ACCOUNT_NOT_RESOLVED');
      }
      return this.gatewayError(error, 'We could not verify that account right now.');
    }
  }

  async createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }> {
    try {
      const data = await this.call<{ recipient_code: string }>('POST', '/transferrecipient', {
        type: 'nuban',
        name: input.name,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
        currency: 'NGN',
      });
      return { recipientCode: data.recipient_code };
    } catch (error) {
      return this.gatewayError(error, 'We could not register that payout account.');
    }
  }

  async initiateTransfer(input: TransferInput): Promise<TransferResult> {
    try {
      const data = await this.call<{ transfer_code: string; status: string }>('POST', '/transfer', {
        source: 'balance',
        amount: toKobo(input.amount),
        recipient: input.recipientCode,
        reference: input.reference,
        reason: input.reason,
        currency: 'NGN',
      });
      const status = data.status === 'success' ? 'success' : data.status === 'otp' ? 'otp' : data.status === 'failed' ? 'failed' : 'pending';
      return { transferCode: data.transfer_code, status };
    } catch (error) {
      return this.gatewayError(error, 'The payout could not be started with the provider.');
    }
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const header = headers['x-paystack-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !rawBody?.length) return false;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: unknown): ProviderEvent {
    const event = body as { event?: string; data?: Record<string, unknown> };
    const name = event?.event ?? '';
    const data = event?.data ?? {};
    switch (name) {
      case 'charge.success':
        return { type: 'charge.success', reference: String(data.reference), charge: toChargeStatus(data as unknown as PaystackTransaction) };
      case 'transfer.success':
      case 'transfer.failed':
      case 'transfer.reversed':
        return {
          type: name,
          reference: String(data.reference),
          transferCode: data.transfer_code ? String(data.transfer_code) : undefined,
          reason: typeof data.reason === 'string' ? data.reason : undefined,
        };
      case 'refund.processed':
      case 'refund.failed':
      case 'refund.pending': {
        const transaction = (data.transaction ?? {}) as { reference?: string };
        return {
          type: name,
          chargeReference: String(data.transaction_reference ?? transaction.reference ?? ''),
          providerRefundId: data.id !== undefined ? String(data.id) : undefined,
          amount: typeof data.amount === 'number' ? fromKobo(data.amount) : undefined,
        };
      }
      default:
        return { type: 'ignored', name };
    }
  }
}
