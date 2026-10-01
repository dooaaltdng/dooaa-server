import { Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Model } from 'mongoose';
import { Errors } from '../../../common/api/app-error';
import { fromKobo, sumMoney, toKobo } from '../../../common/util/money';
import type { SandboxRecord } from '../schemas/sandbox-record.schema';
import { NIGERIAN_BANKS } from './banks';
import type {
  Bank,
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
import { toChargeStatus } from './paystack.provider';

export type SandboxOptions = { appUrl: string; secret: string; delayMs: number };

/** Account numbers that make the sandbox misbehave on purpose. */
export const SANDBOX_UNRESOLVABLE_ACCOUNT = '0000000000';
export const SANDBOX_FAILING_TRANSFER_SUFFIX = '9999';

/**
 * A stand-in for Paystack with the same shape of flow: initialize → the
 * buyer pays on a hosted page → verify / webhook. Transfers and refunds
 * settle asynchronously and announce themselves as webhooks, exactly as the
 * real provider does. It never auto-succeeds a charge nobody paid.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox' as const;
  private readonly logger = new Logger('SandboxPayments');
  private sink: ((event: ProviderEvent) => Promise<void>) | null = null;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly records: Model<SandboxRecord>,
    private readonly options: SandboxOptions,
  ) {}

  /** Where simulated webhooks are delivered (the payments service's webhook handler). */
  setEventSink(sink: (event: ProviderEvent) => Promise<void>): void {
    this.sink = sink;
  }

  /** Test helper: resolves once every scheduled settlement has been delivered. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private schedule(work: () => Promise<void>): void {
    const job = new Promise<void>((resolve) => setTimeout(resolve, this.options.delayMs))
      .then(work)
      .catch((error) => this.logger.error(`Sandbox settlement failed: ${(error as Error).message}`));
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  private async deliver(event: ProviderEvent): Promise<void> {
    if (this.sink) await this.sink(event);
  }

  private toStatus(record: SandboxRecord): ChargeStatus {
    const data = record.data as Record<string, unknown>;
    return toChargeStatus({
      id: Number(data.id ?? 0),
      reference: record.reference,
      status: record.status,
      amount: toKobo(record.amount),
      currency: 'NGN',
      paid_at: (data.paidAt as string) ?? null,
      channel: data.channel as string | undefined,
      gateway_response: record.status === 'success' ? 'Approved' : record.status === 'failed' ? 'Declined' : undefined,
      customer: { email: data.email as string | undefined },
      authorization: data.authorization as never,
    });
  }

  async initializeCharge(input: InitializeChargeInput): Promise<InitializedCharge> {
    await this.records.create({
      kind: 'charge',
      reference: input.reference,
      status: 'pending',
      amount: input.amount,
      data: {
        id: Date.now(),
        email: input.email,
        callbackUrl: input.callbackUrl,
        channels: input.channels ?? ['card', 'bank_transfer', 'ussd'],
        metadata: input.metadata ?? {},
      },
    });
    return {
      reference: input.reference,
      authorizationUrl: `${this.options.appUrl}/api/v1/payments/sandbox/checkout/${encodeURIComponent(input.reference)}`,
      accessCode: `sandbox_${randomBytes(6).toString('hex')}`,
    };
  }

  async charge(reference: string) {
    return this.records.findOne({ kind: 'charge', reference }).lean();
  }

  /**
   * The hosted page's buttons. A successful card payment produces a reusable
   * authorization whose signature is stable per card holder, so saved cards
   * de-duplicate the way Paystack's do.
   */
  async complete(reference: string, outcome: 'success' | 'failed', channel: 'card' | 'bank_transfer' | 'ussd' = 'card'): Promise<ChargeStatus> {
    const record = await this.records.findOne({ kind: 'charge', reference }).lean();
    if (!record) throw Errors.notFound('That sandbox payment does not exist.', 'SANDBOX_NOT_FOUND');
    if (record.status !== 'pending') return this.toStatus(record);
    const email = String((record.data as { email?: string }).email ?? '');
    const signature = `SIG_sandbox_${createHash('sha1').update(email).digest('hex').slice(0, 16)}`;
    const data = {
      ...(record.data as object),
      channel,
      paidAt: outcome === 'success' ? new Date().toISOString() : undefined,
      authorization:
        outcome === 'success' && channel === 'card'
          ? {
              authorization_code: `AUTH_sandbox_${randomBytes(6).toString('hex')}`,
              signature,
              last4: '4081',
              brand: 'visa',
              bank: 'TEST BANK',
              exp_month: '12',
              exp_year: '2030',
              reusable: true,
              channel: 'card',
            }
          : undefined,
    };
    const updated = await this.records
      .findOneAndUpdate({ _id: record._id, status: 'pending' }, { $set: { status: outcome, data } }, { returnDocument: 'after' })
      .lean();
    const status = this.toStatus(updated ?? record);
    if (outcome === 'success') this.schedule(() => this.deliver({ type: 'charge.success', reference, charge: status }));
    return status;
  }

  async verifyCharge(reference: string): Promise<ChargeStatus> {
    const record = await this.records.findOne({ kind: 'charge', reference }).lean();
    if (!record) return { reference, status: 'pending', amount: 0, currency: 'NGN' };
    return this.toStatus(record);
  }

  async chargeAuthorization(input: { authorizationCode: string; email: string; amount: number; reference: string }): Promise<ChargeStatus> {
    const ok = input.authorizationCode.startsWith('AUTH_sandbox_');
    await this.records.create({
      kind: 'charge',
      reference: input.reference,
      status: ok ? 'success' : 'failed',
      amount: input.amount,
      data: {
        id: Date.now(),
        email: input.email,
        channel: 'card',
        paidAt: ok ? new Date().toISOString() : undefined,
        authorization: ok
          ? { authorization_code: input.authorizationCode, last4: '4081', brand: 'visa', bank: 'TEST BANK', exp_month: '12', exp_year: '2030', reusable: true, channel: 'card' }
          : undefined,
      },
    });
    const status = await this.verifyCharge(input.reference);
    if (ok) this.schedule(() => this.deliver({ type: 'charge.success', reference: input.reference, charge: status }));
    return status;
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const charge = await this.records.findOne({ kind: 'charge', reference: input.chargeReference }).lean();
    if (!charge || charge.status !== 'success') {
      throw Errors.badGateway('The provider has no successful charge to refund.', 'PAYMENT_PROVIDER_ERROR');
    }
    const previous = await this.records.find({ kind: 'refund', 'data.chargeReference': input.chargeReference, status: { $ne: 'failed' } }).lean();
    const refunded = sumMoney(...previous.map((row) => row.amount));
    if (toKobo(refunded) + toKobo(input.amount) > toKobo(charge.amount)) {
      throw Errors.badGateway('The refund is larger than what is left on the charge.', 'PAYMENT_PROVIDER_ERROR');
    }
    const providerRefundId = `RF_sandbox_${randomBytes(5).toString('hex')}`;
    await this.records.create({
      kind: 'refund',
      reference: providerRefundId,
      status: 'pending',
      amount: input.amount,
      data: { chargeReference: input.chargeReference, refundReference: input.refundReference, reason: input.reason },
    });
    this.schedule(async () => {
      await this.records.updateOne({ kind: 'refund', reference: providerRefundId }, { $set: { status: 'processed' } });
      await this.deliver({
        type: 'refund.processed',
        chargeReference: input.chargeReference,
        providerRefundId,
        refundReference: input.refundReference,
        amount: input.amount,
      });
    });
    return { providerRefundId, status: 'pending' };
  }

  async listBanks(): Promise<Bank[]> {
    return NIGERIAN_BANKS;
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    const bank = NIGERIAN_BANKS.find((entry) => entry.code === bankCode);
    if (!bank || !/^\d{10}$/.test(accountNumber) || accountNumber === SANDBOX_UNRESOLVABLE_ACCOUNT) {
      throw Errors.badRequest('We could not verify that account number with the bank.', 'ACCOUNT_NOT_RESOLVED');
    }
    return { accountName: `DOOAA SANDBOX ${accountNumber.slice(-4)}`, accountNumber, bankCode };
  }

  async createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }> {
    const recipientCode = `RCP_sandbox_${createHash('sha1').update(`${input.bankCode}:${input.accountNumber}`).digest('hex').slice(0, 14)}`;
    await this.records.updateOne(
      { kind: 'recipient', reference: recipientCode },
      { $set: { status: 'active', data: { name: input.name, accountNumber: input.accountNumber, bankCode: input.bankCode } } },
      { upsert: true },
    );
    return { recipientCode };
  }

  async initiateTransfer(input: TransferInput): Promise<TransferResult> {
    const recipient = await this.records.findOne({ kind: 'recipient', reference: input.recipientCode }).lean();
    if (!recipient) throw Errors.badGateway('The provider does not know that recipient.', 'PAYMENT_PROVIDER_ERROR');
    const transferCode = `TRF_sandbox_${randomBytes(5).toString('hex')}`;
    const fails = String((recipient.data as { accountNumber?: string }).accountNumber ?? '').endsWith(SANDBOX_FAILING_TRANSFER_SUFFIX);
    await this.records.create({ kind: 'transfer', reference: input.reference, status: 'pending', amount: input.amount, data: { transferCode, recipientCode: input.recipientCode, reason: input.reason } });
    this.schedule(async () => {
      await this.records.updateOne({ kind: 'transfer', reference: input.reference }, { $set: { status: fails ? 'failed' : 'success' } });
      await this.deliver({
        type: fails ? 'transfer.failed' : 'transfer.success',
        reference: input.reference,
        transferCode,
        reason: fails ? 'Beneficiary bank unavailable' : undefined,
      });
    });
    return { transferCode, status: 'pending' };
  }

  private sign(rawBody: Buffer | string): string {
    return createHmac('sha512', this.options.secret).update(rawBody).digest('hex');
  }

  /** For manual testing with curl: sign a payload the way the webhook expects. */
  signPayload(rawBody: string): string {
    return this.sign(rawBody);
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const header = headers['x-sandbox-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !rawBody?.length) return false;
    const a = Buffer.from(this.sign(rawBody));
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Sandbox webhooks use Paystack's payload shape. */
  parseWebhook(body: unknown): ProviderEvent {
    const event = body as { event?: string; data?: Record<string, unknown> };
    const data = event?.data ?? {};
    switch (event?.event) {
      case 'charge.success':
        return {
          type: 'charge.success',
          reference: String(data.reference),
          charge: toChargeStatus({ id: 0, reference: String(data.reference), status: 'success', amount: Number(data.amount ?? 0), currency: String(data.currency ?? 'NGN') }),
        };
      case 'transfer.success':
      case 'transfer.failed':
      case 'transfer.reversed':
        return { type: event.event, reference: String(data.reference), transferCode: data.transfer_code as string | undefined };
      case 'refund.processed':
      case 'refund.failed':
        return { type: event.event, chargeReference: String(data.transaction_reference ?? ''), providerRefundId: data.id as string | undefined, amount: typeof data.amount === 'number' ? fromKobo(data.amount) : undefined };
      default:
        return { type: 'ignored', name: String(event?.event ?? '') };
    }
  }
}
