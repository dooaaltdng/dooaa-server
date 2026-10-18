import request from 'supertest';
import type { TestApp } from './app';
import { codeFromMail, type TestUser } from './factories';
import { API, Http, data } from './http';

export const DELIVERY = {
  firstName: 'Nelson',
  lastName: 'Okafor',
  address: '12 Admiralty Way, Lekki Phase 1',
  city: 'Lagos',
  state: 'Lagos',
  phone: '08031234567',
  email: 'nelson@example.com',
};

/** Waits for Bachs' webhooks (charges, refunds, payouts) and queued mail to land. */
export async function settle(t: TestApp): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await t.bachs.idle();
    await t.mail.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The buyer pays on Bachs' hosted checkout. */
export function bachsPay(t: TestApp, reference: string, outcome: 'success' | 'failed' = 'success', options: { method?: 'NGN_CARD' | 'NGN_BANK_TRANSFER'; amount?: number } = {}) {
  return t.bachs.pay(reference, outcome, options);
}

/** Pays and confirms, the way the client's callback page does. */
export async function payAndVerify(t: TestApp, buyer: TestUser, reference: string, outcome: 'success' | 'failed' = 'success') {
  const http = new Http(t);
  bachsPay(t, reference, outcome);
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

/** Posts an event to the webhook, signed the way Bachs signs it. */
export function signedWebhook(t: TestApp, event: unknown) {
  const raw = JSON.stringify(event);
  return request(t.server).post(`${API}/payments/webhooks/bachs`).set(t.bachs.signatureHeaders(raw)).send(raw);
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
