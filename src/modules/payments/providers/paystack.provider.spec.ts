import { createHmac } from 'node:crypto';
import { AppError } from '../../../common/api/app-error';
import { PaystackProvider } from './paystack.provider';

const SECRET = 'sk_test_dooaa';

function respond(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('PaystackProvider', () => {
  let provider: PaystackProvider;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    provider = new PaystackProvider(SECRET, 'https://api.paystack.test');
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };

  describe('charges', () => {
    it('initializes in kobo with the secret key and returns the hosted checkout', async () => {
      fetchMock.mockReturnValue(respond(200, { status: true, message: 'ok', data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'DOO-1' } }));
      const result = await provider.initializeCharge({
        reference: 'DOO-1',
        amount: 1_799_000.5,
        email: 'buyer@example.com',
        callbackUrl: 'https://dooaa.ng/checkout/callback',
        channels: ['card'],
        metadata: { checkoutId: 'chk_1' },
      });
      const { url, init, body } = lastCall();
      expect(url).toBe('https://api.paystack.test/transaction/initialize');
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
      expect(body).toEqual({
        email: 'buyer@example.com',
        amount: 179_900_050,
        currency: 'NGN',
        reference: 'DOO-1',
        callback_url: 'https://dooaa.ng/checkout/callback',
        channels: ['card'],
        metadata: { checkoutId: 'chk_1' },
      });
      expect(result).toEqual({ reference: 'DOO-1', authorizationUrl: 'https://checkout.paystack.com/abc', accessCode: 'abc' });
    });

    it('maps a verified transaction back to Naira with the card authorization', async () => {
      fetchMock.mockReturnValue(
        respond(200, {
          status: true,
          message: 'Verification successful',
          data: {
            id: 4099260516,
            reference: 'DOO-1',
            status: 'success',
            amount: 40_500_000,
            currency: 'NGN',
            paid_at: '2026-10-01T10:00:00.000Z',
            channel: 'card',
            gateway_response: 'Approved',
            customer: { email: 'buyer@example.com' },
            authorization: { authorization_code: 'AUTH_x', signature: 'SIG_y', last4: '4081', card_type: 'visa ', bank: 'TEST BANK', exp_month: '12', exp_year: '2030', reusable: true, channel: 'card' },
          },
        }),
      );
      const status = await provider.verifyCharge('DOO-1');
      expect(lastCall().url).toBe('https://api.paystack.test/transaction/verify/DOO-1');
      expect(status).toMatchObject({
        reference: 'DOO-1',
        status: 'success',
        amount: 405_000,
        currency: 'NGN',
        channel: 'card',
        providerTransactionId: '4099260516',
        authorization: { authorizationCode: 'AUTH_x', signature: 'SIG_y', last4: '4081', brand: 'visa', reusable: true },
      });
      expect(status.paidAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
    });

    it.each([
      ['failed', 'failed'],
      ['reversed', 'failed'],
      ['abandoned', 'abandoned'],
      ['ongoing', 'pending'],
    ])('maps provider status %s to %s', async (providerStatus, expected) => {
      fetchMock.mockReturnValue(respond(200, { status: true, message: 'ok', data: { id: 1, reference: 'R', status: providerStatus, amount: 100, currency: 'NGN' } }));
      expect((await provider.verifyCharge('R')).status).toBe(expected);
    });

    it('treats an unknown reference as still pending', async () => {
      fetchMock.mockReturnValue(respond(404, { status: false, message: 'Transaction reference not found' }));
      expect(await provider.verifyCharge('nope')).toMatchObject({ status: 'pending', amount: 0 });
    });

    it('reports an unreachable provider as a 502 the app can retry', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expect(provider.verifyCharge('R')).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
    });

    it('reports a provider refusal as a 502 with its message', async () => {
      fetchMock.mockReturnValue(respond(400, { status: false, message: 'Invalid key' }));
      const error = await provider
        .initializeCharge({ reference: 'R', amount: 1, email: 'a@b.co', callbackUrl: 'https://x' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR', details: { provider: 'Invalid key' } });
    });

    it('charges a saved authorization', async () => {
      fetchMock.mockReturnValue(respond(200, { status: true, message: 'ok', data: { id: 2, reference: 'R2', status: 'success', amount: 500_000, currency: 'NGN' } }));
      const status = await provider.chargeAuthorization({ authorizationCode: 'AUTH_x', email: 'a@b.co', amount: 5_000, reference: 'R2' });
      expect(lastCall().body).toMatchObject({ authorization_code: 'AUTH_x', amount: 500_000, reference: 'R2' });
      expect(status.status).toBe('success');
    });
  });

  describe('refunds and transfers', () => {
    it('refunds part of a charge in kobo', async () => {
      fetchMock.mockReturnValue(respond(200, { status: true, message: 'ok', data: { id: 77, status: 'pending' } }));
      const result = await provider.refund({ chargeReference: 'DOO-1', amount: 1_250.25, refundReference: 'rf_1', reason: 'Cancelled' });
      expect(lastCall().body).toMatchObject({ transaction: 'DOO-1', amount: 125_025, currency: 'NGN', customer_note: 'Cancelled' });
      expect(result).toEqual({ providerRefundId: '77', status: 'pending' });
    });

    it('resolves an account name, and turns a bad number into a 400', async () => {
      fetchMock.mockReturnValueOnce(respond(200, { status: true, message: 'ok', data: { account_name: 'NELSON OKAFOR', account_number: '0123456789' } }));
      expect(await provider.resolveAccount('0123456789', '058')).toEqual({ accountName: 'NELSON OKAFOR', accountNumber: '0123456789', bankCode: '058' });
      expect(lastCall().url).toBe('https://api.paystack.test/bank/resolve?account_number=0123456789&bank_code=058');

      fetchMock.mockReturnValueOnce(respond(422, { status: false, message: 'Could not resolve account name' }));
      await expect(provider.resolveAccount('0000000000', '058')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_RESOLVED' });
    });

    it('registers a NUBAN transfer recipient', async () => {
      fetchMock.mockReturnValue(respond(201, { status: true, message: 'ok', data: { recipient_code: 'RCP_abc' } }));
      expect(await provider.createTransferRecipient({ name: 'NELSON OKAFOR', accountNumber: '0123456789', bankCode: '058' })).toEqual({ recipientCode: 'RCP_abc' });
      expect(lastCall().body).toEqual({ type: 'nuban', name: 'NELSON OKAFOR', account_number: '0123456789', bank_code: '058', currency: 'NGN' });
    });

    it.each([
      ['success', 'success'],
      ['otp', 'otp'],
      ['pending', 'pending'],
      ['failed', 'failed'],
    ])('starts a transfer from balance (provider says %s)', async (providerStatus, expected) => {
      fetchMock.mockReturnValue(respond(200, { status: true, message: 'ok', data: { transfer_code: 'TRF_1', status: providerStatus } }));
      const result = await provider.initiateTransfer({ amount: 15_000, recipientCode: 'RCP_abc', reference: 'po_1', reason: 'DOOAA payout' });
      expect(lastCall().body).toEqual({ source: 'balance', amount: 1_500_000, recipient: 'RCP_abc', reference: 'po_1', reason: 'DOOAA payout', currency: 'NGN' });
      expect(result).toEqual({ transferCode: 'TRF_1', status: expected });
    });

    it('lists only active banks', async () => {
      fetchMock.mockReturnValue(
        respond(200, { status: true, message: 'ok', data: [{ name: 'Access Bank', code: '044', slug: 'access-bank', active: true }, { name: 'Old Bank', code: '999', slug: 'old', active: false }] }),
      );
      expect(await provider.listBanks()).toEqual([{ name: 'Access Bank', code: '044', slug: 'access-bank' }]);
    });
  });

  describe('webhooks', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'DOO-1' } }));
    const sign = (raw: Buffer, secret = SECRET) => createHmac('sha512', secret).update(raw).digest('hex');

    it('accepts the HMAC-SHA512 signature made with the secret key', () => {
      expect(provider.verifyWebhookSignature(body, { 'x-paystack-signature': sign(body) })).toBe(true);
    });

    it('rejects a wrong, foreign or missing signature', () => {
      expect(provider.verifyWebhookSignature(body, { 'x-paystack-signature': sign(body, 'other') })).toBe(false);
      expect(provider.verifyWebhookSignature(body, { 'x-paystack-signature': 'abc' })).toBe(false);
      expect(provider.verifyWebhookSignature(body, {})).toBe(false);
      expect(provider.verifyWebhookSignature(Buffer.from('{"tampered":true}'), { 'x-paystack-signature': sign(body) })).toBe(false);
    });

    it('parses charge, transfer and refund events', () => {
      expect(provider.parseWebhook({ event: 'charge.success', data: { id: 1, reference: 'DOO-1', status: 'success', amount: 100_00, currency: 'NGN' } })).toMatchObject({
        type: 'charge.success',
        reference: 'DOO-1',
        charge: { amount: 100, status: 'success' },
      });
      expect(provider.parseWebhook({ event: 'transfer.failed', data: { reference: 'po_1', transfer_code: 'TRF_1', reason: 'Account closed' } })).toEqual({
        type: 'transfer.failed',
        reference: 'po_1',
        transferCode: 'TRF_1',
        reason: 'Account closed',
      });
      expect(provider.parseWebhook({ event: 'refund.processed', data: { id: 77, transaction_reference: 'DOO-1', amount: 125_025 } })).toEqual({
        type: 'refund.processed',
        chargeReference: 'DOO-1',
        providerRefundId: '77',
        amount: 1_250.25,
      });
      expect(provider.parseWebhook({ event: 'subscription.create', data: {} })).toEqual({ type: 'ignored', name: 'subscription.create' });
    });
  });
});
