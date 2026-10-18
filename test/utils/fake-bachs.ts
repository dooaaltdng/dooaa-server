import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A stand-in for the Bachs API (https://docs.bachs.io) that the e2e suite
 * points the real BachsProvider at. It keeps its own ledger, answers the
 * endpoints DOOAA calls, enforces what Bachs enforces (secret key, unique
 * references, idempotency keys, one live refund per charge) and delivers
 * signed webhooks back to the app the way Bachs does.
 */

export const FAKE_BACHS_SECRET_KEY = 'sk_sandbox_dooaa_test';
export const FAKE_BACHS_WEBHOOK_SECRET = 'whsec_dooaa_test';

/** Account numbers that make the fake misbehave on purpose. */
export const UNRESOLVABLE_ACCOUNT = '0000000000';
export const FAILING_PAYOUT_SUFFIX = '9999';

export const TEST_BANKS = [
  { name: 'Access Bank', code: '044' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'Guaranty Trust Bank', code: '058' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'United Bank For Africa', code: '033' },
  { name: 'Zenith Bank', code: '057' },
];

type Checkout = {
  checkout_id: string;
  checkout_url: string;
  reference: string;
  amount: string;
  currency: string;
  status: 'open' | 'completed' | 'expired' | 'cancelled';
  customer: Record<string, unknown>;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, unknown>;
  payment_method_types: string[];
  expires_at: string;
  completed_at: string | null;
  payment_method: string | null;
  charge: { payment_id: string; status: string; amount: string; currency: string; amount_paid: string } | null;
};

type Refund = { refund_id: string; charge_id: string; reference: string; status: 'processing' | 'success' | 'failed'; requested_amount: string; reason?: string };
type Destination = { id: string; name: string; account_number: string; bank_code: string; status: 'pending_review' | 'approved' | 'rejected'; is_usable: boolean };
type Payout = { id: string; reference: string; destination: string; amount: string; status: 'pending' | 'processing' | 'completed' | 'failed'; failure_reason: string | null };

type Handler = (body: Record<string, unknown>, params: string[], request: IncomingMessage) => { status: number; body: unknown };

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

export class FakeBachs {
  readonly checkouts = new Map<string, Checkout>();
  readonly refunds = new Map<string, Refund>();
  readonly destinations = new Map<string, Destination>();
  readonly payouts = new Map<string, Payout>();
  /** Every request DOOAA made, for assertions. */
  readonly requests: { method: string; path: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = [];
  /** Where webhooks go; set once the app is listening. */
  webhookUrl = '';
  /** New payout destinations are approved at once unless a test says otherwise. */
  autoApproveDestinations = true;

  private server: Server | null = null;
  private baseUrl = '';
  private readonly idempotent = new Map<string, { status: number; body: unknown }>();
  private readonly deliveries = new Set<Promise<void>>();
  private readonly failures: { method: string; path: RegExp; status: number; code: string; detail: string }[] = [];

  get url(): string {
    return this.baseUrl;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await this.idle();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Makes the next matching request fail the way Bachs reports errors. */
  failNext(method: string, path: RegExp, status = 422, code = 'VALIDATION_ERROR', detail = 'Rejected by the test'): void {
    this.failures.push({ method, path, status, code, detail });
  }

  /** Resolves once every webhook scheduled so far has been delivered. */
  async idle(): Promise<void> {
    while (this.deliveries.size) await Promise.allSettled([...this.deliveries]);
  }

  /* --- The buyer on the hosted page ----------------------------------------------- */

  checkoutFor(reference: string): Checkout {
    const checkout = [...this.checkouts.values()].find((entry) => entry.reference === reference);
    if (!checkout) throw new Error(`No Bachs checkout for ${reference}`);
    return checkout;
  }

  /**
   * The buyer pays (or the payment is declined). `amount` lets a test pay
   * something other than what was asked for.
   */
  pay(reference: string, outcome: 'success' | 'failed' = 'success', options: { method?: 'NGN_CARD' | 'NGN_BANK_TRANSFER'; amount?: number } = {}): Checkout {
    const checkout = this.checkoutFor(reference);
    if (checkout.status !== 'open') return checkout;
    const amount = options.amount !== undefined ? options.amount.toFixed(2) : checkout.amount;
    const paymentId = checkout.charge?.payment_id ?? id('ch');
    checkout.payment_method = options.method ?? (checkout.payment_method_types[0] || 'NGN_CARD');
    checkout.charge = { payment_id: paymentId, status: outcome === 'success' ? 'succeeded' : 'failed', amount, currency: checkout.currency, amount_paid: amount };
    if (outcome === 'success') {
      checkout.status = 'completed';
      checkout.completed_at = new Date().toISOString();
    }
    this.deliver(outcome === 'success' ? 'collection.succeeded' : 'collection.failed', {
      charge_id: paymentId,
      checkout_id: checkout.checkout_id,
      reference: checkout.reference,
      amount_paid: amount,
      amount_expected: checkout.amount,
      currency: checkout.currency,
      metadata: checkout.metadata,
    });
    return checkout;
  }

  /** The buyer pressed Cancel on the hosted page. */
  cancel(reference: string): void {
    this.checkoutFor(reference).status = 'cancelled';
  }

  /** The session ran out (Bachs says so with checkout.expired). */
  expire(reference: string): void {
    const checkout = this.checkoutFor(reference);
    checkout.status = 'expired';
    this.deliver('checkout.expired', { checkout_id: checkout.checkout_id, reference: checkout.reference });
  }

  /* --- Webhooks -------------------------------------------------------------------- */

  /** The headers Bachs signs a delivery with. */
  signatureHeaders(raw: string, secret = FAKE_BACHS_WEBHOOK_SECRET): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-Bachs-Timestamp': timestamp,
      'X-Bachs-Signature': signature,
      'X-Bachs-Signature-V2': `t=${timestamp},v1=${signature}`,
    };
  }

  /** An event envelope as Bachs sends it. */
  event(type: string, data: Record<string, unknown>): { id: string; type: string; created_at: string; organization_id: string; data: Record<string, unknown> } {
    return { id: id('evt'), type, created_at: new Date().toISOString(), organization_id: 'org_test', data };
  }

  private deliver(type: string, data: Record<string, unknown>): void {
    if (!this.webhookUrl) return;
    const raw = JSON.stringify(this.event(type, data));
    const job = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => fetch(this.webhookUrl, { method: 'POST', headers: this.signatureHeaders(raw), body: raw }))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Webhook ${type} answered ${response.status}: ${await response.text()}`);
      })
      .catch((error: Error) => console.error(`[fake-bachs] ${error.message}`));
    this.deliveries.add(job);
    void job.finally(() => this.deliveries.delete(job));
  }

  /* --- HTTP --------------------------------------------------------------------------- */

  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [
    { method: 'POST', pattern: /^\/v1\/checkout-sessions$/, handler: (body) => this.createCheckout(body) },
    { method: 'GET', pattern: /^\/v1\/checkout-sessions\/([^/]+)$/, handler: (_body, [checkoutId]) => this.getCheckout(checkoutId) },
    { method: 'GET', pattern: /^\/v1\/payments\/([^/]+)$/, handler: (_body, [paymentId]) => this.getPayment(paymentId) },
    { method: 'POST', pattern: /^\/v1\/refunds$/, handler: (body) => this.createRefund(body) },
    { method: 'GET', pattern: /^\/v1\/reference\/banks$/, handler: () => ({ status: 200, body: { country: 'NG', banks: TEST_BANKS } }) },
    { method: 'POST', pattern: /^\/v1\/misc\/bank-accounts\/resolve$/, handler: (body) => this.resolveAccount(body) },
    { method: 'POST', pattern: /^\/v1\/payouts\/destinations$/, handler: (body) => this.createDestination(body) },
    { method: 'GET', pattern: /^\/v1\/payouts\/destinations\/([^/]+)$/, handler: (_body, [destinationId]) => this.getDestination(destinationId) },
    { method: 'POST', pattern: /^\/v1\/payouts$/, handler: (body) => this.createPayout(body) },
  ];

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const path = (request.url ?? '/').split('?')[0];
    const method = request.method ?? 'GET';
    this.requests.push({ method, path, body, headers: request.headers });

    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': id('req') });
      response.end(JSON.stringify(payload));
    };

    if (request.headers.authorization !== `Bearer ${FAKE_BACHS_SECRET_KEY}`) {
      send(401, { detail: 'Invalid API key.', error_code: 'UNAUTHORIZED' });
      return;
    }
    const failure = this.failures.findIndex((entry) => entry.method === method && entry.path.test(path));
    if (failure >= 0) {
      const [planned] = this.failures.splice(failure, 1);
      send(planned.status, { detail: planned.detail, error_code: planned.code });
      return;
    }
    const route = this.routes.find((entry) => entry.method === method && entry.pattern.test(path));
    if (!route) {
      send(404, { detail: 'Not found.', error_code: 'NOT_FOUND' });
      return;
    }

    // An idempotency key replays the first answer; reusing it for a different request is a conflict.
    const key = request.headers['idempotency-key'];
    const fingerprint = createHash('sha256').update(`${method} ${path} ${text}`).digest('hex');
    if (typeof key === 'string') {
      const previous = this.idempotent.get(key);
      if (previous) {
        if ((previous as { fingerprint?: string }).fingerprint !== fingerprint) {
          send(409, { detail: 'Idempotency key reused with a different request.', error_code: 'IDEMPOTENCY_CONFLICT' });
          return;
        }
        send(previous.status, previous.body);
        return;
      }
    }
    const result = route.handler(body, path.match(route.pattern)!.slice(1), request);
    if (typeof key === 'string') this.idempotent.set(key, { ...result, fingerprint } as never);
    send(result.status, result.body);
  }

  private createCheckout(body: Record<string, unknown>) {
    const pricing = (body.pricing ?? {}) as { currency?: string; amount?: string };
    const reference = String(body.reference ?? '');
    if (!pricing.amount || Number(pricing.amount) < 100) return { status: 422, body: { detail: 'Minimum 100 for NGN.', error_code: 'VALIDATION_ERROR' } };
    if ([...this.checkouts.values()].some((entry) => entry.reference === reference)) {
      return { status: 409, body: { detail: 'Duplicate reference.', error_code: 'DUPLICATE_REFERENCE' } };
    }
    const checkoutId = id('chk');
    const minutes = Number(body.expires_in_minutes ?? 60);
    const checkout: Checkout = {
      checkout_id: checkoutId,
      checkout_url: `https://checkout.bachs.test/c/${checkoutId}`,
      reference,
      amount: pricing.amount,
      currency: pricing.currency ?? 'NGN',
      status: 'open',
      customer: (body.customer ?? {}) as Record<string, unknown>,
      success_url: String(body.success_url ?? ''),
      cancel_url: String(body.cancel_url ?? ''),
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
      payment_method_types: (body.payment_method_types ?? []) as string[],
      expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
      completed_at: null,
      payment_method: null,
      charge: null,
    };
    this.checkouts.set(checkoutId, checkout);
    return {
      status: 201,
      body: { checkout_id: checkoutId, checkout_url: checkout.checkout_url, status: 'open', expires_at: checkout.expires_at, created_at: new Date().toISOString(), reference },
    };
  }

  private getCheckout(checkoutId: string) {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) return { status: 404, body: { detail: 'Checkout session not found.', error_code: 'NOT_FOUND' } };
    const { charge, ...rest } = checkout;
    return {
      status: 200,
      body: {
        ...rest,
        payment_status: charge?.status === 'succeeded' ? 'paid' : 'unpaid',
        charge: charge ? { payment_id: charge.payment_id, billing_reason: 'checkout', status: charge.status, amount: charge.amount, currency: charge.currency, fee_usd: '0.00' } : null,
      },
    };
  }

  private getPayment(paymentId: string) {
    const checkout = [...this.checkouts.values()].find((entry) => entry.charge?.payment_id === paymentId);
    if (!checkout?.charge) return { status: 404, body: { detail: 'Payment not found.', error_code: 'NOT_FOUND' } };
    return {
      status: 200,
      body: {
        payment_id: paymentId,
        reference: checkout.reference,
        checkout_id: checkout.checkout_id,
        status: checkout.charge.status,
        amount: checkout.amount,
        amount_paid: checkout.charge.amount_paid,
        currency: checkout.currency,
      },
    };
  }

  private createRefund(body: Record<string, unknown>) {
    const chargeId = String(body.charge_id ?? '');
    const checkout = [...this.checkouts.values()].find((entry) => entry.charge?.payment_id === chargeId && entry.charge.status === 'succeeded');
    if (!checkout) return { status: 404, body: { detail: 'Charge not found.', error_code: 'NOT_FOUND' } };
    // Bachs: a charge carries at most one refund that did not fail.
    if ([...this.refunds.values()].some((refund) => refund.charge_id === chargeId && refund.status !== 'failed')) {
      return { status: 409, body: { detail: 'This charge already has a refund.', error_code: 'REFUND_ALREADY_EXISTS' } };
    }
    const requested = body.amount !== undefined ? String(body.amount) : checkout.charge!.amount;
    if (Number(requested) > Number(checkout.charge!.amount)) {
      return { status: 422, body: { detail: 'The refund is larger than the charge.', error_code: 'REFUND_EXCEEDS_CHARGE' } };
    }
    const refund: Refund = { refund_id: id('rfnd'), charge_id: chargeId, reference: String(body.reference ?? ''), status: 'processing', requested_amount: requested, reason: body.reason as string | undefined };
    this.refunds.set(refund.refund_id, refund);
    setImmediate(() => {
      refund.status = 'success';
      this.deliver('refund.paid', { refund_id: refund.refund_id, charge_id: chargeId, reference: refund.reference, refunded_amount: requested, requested_amount: requested });
    });
    return { status: 201, body: { ...refund, refunded_amount: null, created_at: new Date().toISOString() } };
  }

  private resolveAccount(body: Record<string, unknown>) {
    const accountNumber = String(body.account_number ?? '');
    const known = TEST_BANKS.some((bank) => bank.code === body.bank_code);
    if (!known || !/^\d{10}$/.test(accountNumber) || accountNumber === UNRESOLVABLE_ACCOUNT) {
      return { status: 200, body: { resolved: false, account_name: null, account_number: accountNumber, message: 'Could not resolve account.' } };
    }
    return { status: 200, body: { resolved: true, account_name: `DOOAA SANDBOX ${accountNumber.slice(-4)}`, account_number: accountNumber, message: 'Account resolved.' } };
  }

  private createDestination(body: Record<string, unknown>) {
    const destination: Destination = {
      id: id('pd'),
      name: String(body.name ?? ''),
      account_number: String(body.account_number ?? ''),
      bank_code: String(body.bank_code ?? ''),
      status: this.autoApproveDestinations ? 'approved' : 'pending_review',
      is_usable: this.autoApproveDestinations,
    };
    this.destinations.set(destination.id, destination);
    return { status: 201, body: { id: destination.id, status: destination.status, is_usable: destination.is_usable, currency: 'NGN' } };
  }

  /** Approves a destination that was waiting on review. */
  approveDestination(destinationId: string): void {
    const destination = this.destinations.get(destinationId);
    if (destination) Object.assign(destination, { status: 'approved', is_usable: true });
  }

  private getDestination(destinationId: string) {
    const destination = this.destinations.get(destinationId);
    if (!destination) return { status: 404, body: { detail: 'Destination not found.', error_code: 'NOT_FOUND' } };
    return { status: 200, body: { id: destination.id, status: destination.status, is_usable: destination.is_usable } };
  }

  private createPayout(body: Record<string, unknown>) {
    const destination = this.destinations.get(String(body.destination ?? ''));
    if (!destination) return { status: 404, body: { detail: 'Destination not found.', error_code: 'NOT_FOUND' } };
    if (!destination.is_usable) return { status: 422, body: { detail: 'Destination is not approved.', error_code: 'DESTINATION_NOT_USABLE' } };
    const payout: Payout = { id: id('pay'), reference: String(body.reference ?? ''), destination: destination.id, amount: String(body.amount), status: 'pending', failure_reason: null };
    this.payouts.set(payout.id, payout);
    const fails = destination.account_number.endsWith(FAILING_PAYOUT_SUFFIX);
    setImmediate(() => {
      payout.status = fails ? 'failed' : 'completed';
      payout.failure_reason = fails ? 'Beneficiary bank unavailable' : null;
      this.deliver(fails ? 'payout.failed' : 'payout.paid', { ...payout });
    });
    return { status: 201, body: { ...payout, currency: 'NGN', created_at: new Date().toISOString() } };
  }
}
