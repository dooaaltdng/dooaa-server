import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { TestApp } from './app';
import { API, Http, data } from './http';
import { codeFromMail, type TestUser } from './factories';
import { PAYMENT_PROVIDER } from '../../src/modules/payments/providers/payment-provider';
import { SandboxProvider } from '../../src/modules/payments/providers/sandbox.provider';

export const DELIVERY = {
  firstName: 'Nelson',
  lastName: 'Okafor',
  address: '12 Admiralty Way, Lekki Phase 1',
  city: 'Lagos',
  state: 'Lagos',
  phone: '08031234567',
  email: 'nelson@example.com',
};

/** Waits for the sandbox's simulated webhooks (charges, refunds, transfers) and queued mail. */
export async function settle(t: TestApp): Promise<void> {
  const provider = t.get<SandboxProvider>(PAYMENT_PROVIDER);
  for (let round = 0; round < 3; round += 1) {
    await provider.idle();
    await t.mail.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The buyer pays on the sandbox's hosted page. */
export async function sandboxPay(t: TestApp, reference: string, outcome: 'success' | 'failed' = 'success', channel = 'card') {
  const http = new Http(t);
  return data(await http.post(`/payments/sandbox/${encodeURIComponent(reference)}/pay`, { outcome, channel }));
}

/** Pays and confirms, the way the client's callback page does. */
export async function payAndVerify(t: TestApp, buyer: TestUser, reference: string, outcome: 'success' | 'failed' = 'success') {
  const http = new Http(t);
  await sandboxPay(t, reference, outcome);
  const payment = data(await http.post(`/payments/${encodeURIComponent(reference)}/verify`, {}, buyer.token));
  await settle(t);
  return payment;
}

export async function cartCheckout(t: TestApp, buyer: TestUser, items: { productId: string; quantity?: number }[], method = 'card') {
  const http = new Http(t);
  for (const item of items) data(await http.post('/cart/items', { productId: item.productId, quantity: item.quantity ?? 1 }, buyer.token));
  data(await http.put('/cart/delivery', DELIVERY, buyer.token));
  return data(await http.post('/checkout', { method }, buyer.token));
}

/** One paid order for one product, returned as the buyer sees it. */
export async function paidOrder(t: TestApp, buyer: TestUser, productId: string, quantity = 1) {
  const checkout = await cartCheckout(t, buyer, [{ productId, quantity }]);
  await payAndVerify(t, buyer, checkout.payment.reference);
  const http = new Http(t);
  return data(await http.get(`/orders/${checkout.orders[0].id}`, buyer.token));
}

/** Signs a sandbox webhook the way the provider would. */
export function signedWebhook(t: TestApp, body: unknown) {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha512', process.env.PAYMENT_WEBHOOK_SECRET!).update(raw).digest('hex');
  return request(t.server)
    .post(`${API}/payments/webhooks/sandbox`)
    .set('Content-Type', 'application/json')
    .set('x-sandbox-signature', signature)
    .send(raw);
}

/** Ships, receives and releases an order, ending with money in the seller's balance. */
export async function completeOrder(t: TestApp, buyer: TestUser, seller: TestUser, orderId: string) {
  const http = new Http(t);
  data(await http.post(`/seller/orders/${orderId}/ship`, { carrier: 'GIG Logistics', trackingNumber: 'GIG-1234567' }, seller.token));
  data(await http.post(`/orders/${orderId}/received`, {}, buyer.token));
  data(await http.post(`/orders/${orderId}/release/code`, {}, buyer.token));
  const code = await codeFromMail(t, buyer.email);
  const released = data(await http.post(`/orders/${orderId}/release`, { code }, buyer.token));
  await settle(t);
  return released;
}
