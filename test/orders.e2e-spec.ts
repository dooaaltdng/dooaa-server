import { Types } from 'mongoose';
import request from 'supertest';
import { createTestApp, type TestApp } from './utils/app';
import { API, Http, data, failure } from './utils/http';
import { codeFromMail, createProduct, model, registerSeller, registerUser, setSettings, staffToken, type TestUser } from './utils/factories';
import { DELIVERY, cartCheckout, completeOrder, paidOrder, payAndVerify, sandboxPay, settle, signedWebhook } from './utils/commerce';
import { Product } from '../src/modules/products/schemas/product.schema';
import { Order } from '../src/modules/orders/schemas/order.schema';
import { Earning } from '../src/modules/wallet/wallet.schema';
import { Coupon } from '../src/modules/coupons/coupon.schema';
import { Offer } from '../src/modules/conversations/schemas/offer.schema';
import { OrdersService } from '../src/modules/orders/orders.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { User } from '../src/modules/users/schemas/user.schema';

describe('Cart, checkout, orders and escrow (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let sellerA: TestUser;
  let sellerB: TestUser;

  const stockOf = async (id: unknown) => (await model<Product>(t, Product.name).findById(id).lean())!.stock;
  const newProduct = (seller: TestUser, overrides: Record<string, unknown> = {}) => createProduct(t, seller.id, overrides);

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    sellerA = await registerSeller(t, { storeName: 'Nelson Stores' });
    sellerB = await registerSeller(t, { storeName: 'Mobile World' });
  });
  afterAll(async () => t.close());

  describe('cart', () => {
    it('adds items, prices one delivery per seller and applies the demo coupon', async () => {
      const buyer = await registerUser(t);
      const a1 = await newProduct(sellerA, { price: 400_000 });
      const a2 = await newProduct(sellerA, { price: 15_000 });
      const b1 = await newProduct(sellerB, { price: 720_000 });
      data(await http.post('/cart/items', { productId: String(a1._id) }, buyer.token));
      data(await http.post('/cart/items', { productId: String(a2._id), quantity: 2 }, buyer.token));
      let cart = data(await http.post('/cart/items', { productId: String(b1._id) }, buyer.token));
      expect(cart).toMatchObject({ count: 4, sellers: 2, subtotal: 1_150_000, delivery: 10_000, discount: 0, total: 1_160_000, coupon: null });

      cart = data(await http.post('/cart/coupon', { code: 'dooaa10' }, buyer.token));
      expect(cart).toMatchObject({ coupon: 'DOOAA10', discount: 115_000, total: 1_045_000 });
      failure(await http.post('/cart/coupon', { code: 'FREEMONEY' }, buyer.token), 400, 'COUPON_INVALID');

      cart = data(await http.patch(`/cart/items/${a2._id}`, { quantity: 1 }, buyer.token));
      expect(cart.count).toBe(3);
      cart = data(await http.delete(`/cart/items/${b1._id}`, buyer.token));
      expect(cart).toMatchObject({ sellers: 1, delivery: 5_000 });
      cart = data(await http.delete('/cart/coupon', buyer.token));
      expect(cart.discount).toBe(0);
    });

    it('refuses more than the stock, sold-out items and your own listings', async () => {
      const buyer = await registerUser(t);
      const few = await newProduct(sellerA, { stock: 2 });
      const none = await newProduct(sellerA, { stock: 0 });
      const result = failure(await http.post('/cart/items', { productId: String(few._id), quantity: 3 }, buyer.token), 409, 'INSUFFICIENT_STOCK');
      expect(result.details.available).toBe(2);
      failure(await http.post('/cart/items', { productId: String(none._id) }, buyer.token), 409, 'OUT_OF_STOCK');
      failure(await http.post('/cart/items', { productId: String(few._id) }, sellerA.token), 403, 'OWN_LISTING');
      failure(await http.patch(`/cart/items/${few._id}`, { quantity: 1 }, buyer.token), 404, 'CART_ITEM_NOT_FOUND');
    });

    it('flags lines that stopped being buyable instead of silently dropping them', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { stock: 5 });
      data(await http.post('/cart/items', { productId: String(product._id), quantity: 3 }, buyer.token));
      await model<Product>(t, Product.name).updateOne({ _id: product._id }, { $set: { stock: 0 } });
      const cart = data(await http.get('/cart', buyer.token));
      expect(cart.entries[0]).toMatchObject({ available: false, issue: 'Sold out.' });
      expect(cart.total).toBe(0);
    });

    it('merges a guest cart after sign-in, skipping what cannot be bought', async () => {
      const buyer = await registerUser(t);
      const good = await newProduct(sellerB);
      const gone = await newProduct(sellerB, { status: 'inactive' });
      const cart = data(await http.post('/cart/merge', { items: [{ productId: String(good._id), quantity: 2 }, { productId: String(gone._id) }] }, buyer.token));
      expect(cart.entries.map((entry: any) => entry.product.id)).toEqual([String(good._id)]);
      expect(cart.count).toBe(2);
    });

    it('validates delivery details', async () => {
      const buyer = await registerUser(t);
      failure(await http.put('/cart/delivery', { ...DELIVERY, email: 'nope' }, buyer.token), 400, 'VALIDATION_FAILED');
      expect(data(await http.put('/cart/delivery', DELIVERY, buyer.token)).deliveryInfo).toMatchObject({ city: 'Lagos' });
    });
  });

  describe('cart checkout', () => {
    it('needs delivery details and a verified email', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA);
      data(await http.post('/cart/items', { productId: String(product._id) }, buyer.token));
      failure(await http.post('/checkout', { method: 'card' }, buyer.token), 400, 'DELIVERY_REQUIRED');
      failure(await http.post('/checkout', { method: 'paypal' }, buyer.token), 400, 'VALIDATION_FAILED');
      const unverified = await registerUser(t, { verifyEmail: false });
      failure(await http.post('/checkout', { method: 'card' }, unverified.token), 403, 'EMAIL_NOT_VERIFIED');
    });

    it('splits the cart per seller, reserves stock and sends the buyer to the provider', async () => {
      const buyer = await registerUser(t);
      const a = await newProduct(sellerA, { price: 400_000, stock: 5 });
      const b = await newProduct(sellerB, { price: 720_000, stock: 5 });
      const checkout = await cartCheckout(t, buyer, [{ productId: String(a._id), quantity: 2 }, { productId: String(b._id) }]);

      expect(checkout.orders).toHaveLength(2);
      expect(checkout.orders.every((order: any) => order.status === 'awaiting-payment')).toBe(true);
      expect(checkout.orders.map((order: any) => order.total)).toEqual([805_000, 725_000]);
      expect(checkout.payment).toMatchObject({ status: 'pending', amount: 1_530_000, provider: 'sandbox', method: 'card' });
      expect(checkout.payment.authorizationUrl).toMatch(/\/api\/v1\/payments\/sandbox\/checkout\/DOO-/);
      expect(await stockOf(a._id)).toBe(3);
      expect(await stockOf(b._id)).toBe(4);

      // Unpaid orders stay out of the order history.
      expect(data(await http.get('/orders', buyer.token)).total).toBe(0);

      // The hosted page shows the amount.
      const page = await request(t.server).get(new URL(checkout.payment.authorizationUrl).pathname);
      expect(page.status).toBe(200);
      expect(page.text).toContain('₦1,530,000');
    });

    it('funds the orders once the provider confirms the payment', async () => {
      const buyer = await registerUser(t);
      const a = await newProduct(sellerA, { price: 400_000, stock: 5 });
      const b = await newProduct(sellerB, { price: 720_000, stock: 5 });
      failure(await http.post('/cart/coupon', { code: 'DOOAA10' }, buyer.token), 400, 'COUPON_NOT_APPLICABLE');
      const couponsBefore = (await model<Coupon>(t, Coupon.name).findOne({ code: 'DOOAA10' }).lean())!.redemptions;
      data(await http.post('/cart/items', { productId: String(a._id) }, buyer.token));
      data(await http.post('/cart/items', { productId: String(b._id) }, buyer.token));
      expect(data(await http.post('/cart/coupon', { code: 'DOOAA10' }, buyer.token)).discount).toBe(112_000);
      data(await http.put('/cart/delivery', DELIVERY, buyer.token));
      const checkout = data(await http.post('/checkout', { method: 'card' }, buyer.token));
      const payment = await payAndVerify(t, buyer, checkout.payment.reference);
      expect(payment).toMatchObject({ status: 'paid', card: { last4: '4081', brand: 'visa' } });

      const orders = data(await http.get('/orders', buyer.token));
      expect(orders.total).toBe(2);
      for (const order of orders.rows) {
        expect(order).toMatchObject({ status: 'pending', escrow: { phase: 'funded', state: 'held' }, payment: { status: 'paid', last4: '4081' } });
        expect(order.escrow.reference).toMatch(/^#\d{4}-[A-Z]\d{4}-\d{4}$/);
        expect(order.escrow.shipWithinSeconds).toBeGreaterThan(47 * 3600);
        expect(order.actions).toEqual(['cancel']);
        expect(order.tracking.events[0]).toMatchObject({ label: 'Awaiting seller confirmation' });
      }
      // The coupon was spread across both orders and spent once.
      expect(orders.rows.reduce((sum: number, order: any) => sum + order.discount, 0)).toBe(112_000);
      expect((await model<Coupon>(t, Coupon.name).findOne({ code: 'DOOAA10' }).lean())!.redemptions).toBe(couponsBefore + 1);
      // Bought items left the cart.
      expect(data(await http.get('/cart', buyer.token)).entries).toHaveLength(0);
      // Each seller has the earning pending in escrow.
      expect(data(await http.get('/seller/earnings', sellerB.token)).overview.pending).toBeGreaterThanOrEqual(725_000);
      expect((await model<Product>(t, Product.name).findById(a._id).lean())!.stats.unitsSold).toBe(1);
      expect((await model<User>(t, User.name).findById(buyer.id).lean())!.stats.purchases).toBe(2);
    });

    it('treats a repeated provider webhook as one payment', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { price: 50_000 });
      const checkout = await cartCheckout(t, buyer, [{ productId: String(product._id) }]);
      await sandboxPay(t, checkout.payment.reference);
      const body = { event: 'charge.success', data: { reference: checkout.payment.reference, amount: 5_500_000, currency: 'NGN' } };
      expect((await signedWebhook(t, body)).status).toBe(200);
      expect((await signedWebhook(t, body)).status).toBe(200);
      await settle(t);
      data(await http.post(`/payments/${checkout.payment.reference}/verify`, {}, buyer.token));
      const earnings = await model<Earning>(t, Earning.name).find({ orderId: new Types.ObjectId(checkout.orders[0].orderId) }).lean();
      expect(earnings).toHaveLength(1);
      expect((await model<Product>(t, Product.name).findById(product._id).lean())!.stats.unitsSold).toBe(1);
    });

    it('rejects webhooks without a valid signature', async () => {
      const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'DOO-FAKE' } });
      const response = await request(t.server).post(`${API}/payments/webhooks/sandbox`).set('Content-Type', 'application/json').set('x-sandbox-signature', 'forged').send(raw);
      failure(response, 401, 'INVALID_SIGNATURE');
      failure(await request(t.server).post(`${API}/payments/webhooks/paystack`).send({ event: 'charge.success' }), 401, 'INVALID_SIGNATURE');
    });

    it('cancels the orders and returns the stock when the payment fails', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { stock: 4 });
      const checkout = await cartCheckout(t, buyer, [{ productId: String(product._id), quantity: 2 }]);
      expect(await stockOf(product._id)).toBe(2);
      const payment = await payAndVerify(t, buyer, checkout.payment.reference, 'failed');
      expect(payment.status).toBe('failed');
      expect(await stockOf(product._id)).toBe(4);
      const order = await model<Order>(t, Order.name).findById(checkout.orders[0].orderId).lean();
      expect(order).toMatchObject({ status: 'cancelled', cancelledBy: 'system' });
      // The cart is untouched, so the buyer can try again.
      expect(data(await http.get('/cart', buyer.token)).entries).toHaveLength(1);
    });

    it('lets only the buyer see their payment', async () => {
      const buyer = await registerUser(t);
      const other = await registerUser(t);
      const product = await newProduct(sellerA);
      const checkout = await cartCheckout(t, buyer, [{ productId: String(product._id) }]);
      failure(await http.get(`/payments/${checkout.payment.reference}`, other.token), 404, 'PAYMENT_NOT_FOUND');
      failure(await http.post(`/payments/${checkout.payment.reference}/verify`, {}, other.token), 404, 'PAYMENT_NOT_FOUND');
      expect(data(await http.get(`/payments/${checkout.payment.reference}`, buyer.token)).status).toBe('pending');
    });

    it('never sells the last unit twice', async () => {
      const product = await newProduct(sellerA, { stock: 1 });
      const buyers = await Promise.all([registerUser(t), registerUser(t), registerUser(t)]);
      for (const buyer of buyers) {
        data(await http.post('/cart/items', { productId: String(product._id) }, buyer.token));
        data(await http.put('/cart/delivery', DELIVERY, buyer.token));
      }
      const results = await Promise.all(buyers.map((buyer) => http.post('/checkout', { method: 'card' }, buyer.token)));
      expect(results.filter((response) => response.status === 201)).toHaveLength(1);
      expect(results.filter((response) => response.status === 409).every((response) => response.body.code === 'INSUFFICIENT_STOCK')).toBe(true);
      expect(await stockOf(product._id)).toBe(0);
    });
  });

  describe('order lifecycle', () => {
    it('runs confirm → ship → receive → release, paying the seller', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerB, { price: 200_000 });
      const order = await paidOrder(t, buyer, String(product._id));

      const confirmed = data(await http.post(`/seller/orders/${order.id}/confirm`, {}, sellerB.token));
      expect(confirmed).toMatchObject({ status: 'confirmed', actions: ['ship', 'cancel', 'deliver'], kindLabel: 'One time' });
      expect(data(await http.get(`/orders/${order.id}`, buyer.token)).actions).toEqual(['request-cancellation']);

      const shipped = data(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'GIG Logistics', trackingNumber: 'GIG-998877' }, sellerB.token));
      expect(shipped).toMatchObject({ status: 'shipped', escrow: { phase: 'shipped' }, shipment: { carrier: 'GIG Logistics', trackingNumber: 'GIG-998877' } });
      failure(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'UPS', trackingNumber: 'X-1' }, sellerB.token), 409, 'ORDER_STATE_CHANGED');

      const buyerView = data(await http.get(`/orders/${order.id}`, buyer.token));
      expect(buyerView.tracking).toMatchObject({ number: 'GIG-998877', carrier: 'GIG Logistics' });
      expect(buyerView.tracking.events[0]).toMatchObject({ label: 'In transit', estimate: expect.stringMatching(/^Estimated delivery: /) });
      expect(buyerView.actions).toEqual(['mark-received', 'release', 'dispute']);

      const received = data(await http.post(`/orders/${order.id}/received`, {}, buyer.token));
      expect(received).toMatchObject({ status: 'delivered', escrow: { phase: 'inspection' }, actions: ['release', 'dispute'] });
      expect(received.escrow.inspectionSeconds).toBeGreaterThan(6 * 86_400);
      expect(received.returnBy).toEqual(expect.any(String));

      data(await http.post(`/orders/${order.id}/release/code`, {}, buyer.token));
      failure(await http.post(`/orders/${order.id}/release`, { code: '000000' }, buyer.token), 400);
      const code = await codeFromMail(t, buyer.email);
      const released = data(await http.post(`/orders/${order.id}/release`, { code }, buyer.token));
      expect(released).toMatchObject({ status: 'delivered', escrow: { phase: 'released', state: 'released', settlement: 'released' }, actions: ['review'] });
      await settle(t);

      const earnings = data(await http.get('/seller/earnings', sellerB.token));
      expect(earnings.earnings.map((earning: any) => earning.orderNumber)).toContain(order.number);
      const books = await t.get<WalletService>(WalletService).recompute(sellerB.id);
      expect(earnings.overview).toEqual(books);
    });

    it('keeps each side to its own actions', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA);
      const order = await paidOrder(t, buyer, String(product._id));
      failure(await http.post(`/seller/orders/${order.id}/confirm`, {}, buyer.token), 403, 'ROLE_REQUIRED');
      failure(await http.post(`/seller/orders/${order.id}/confirm`, {}, sellerB.token), 404, 'ORDER_NOT_FOUND');
      failure(await http.get(`/orders/${order.id}`, sellerA.token), 404, 'ORDER_NOT_FOUND');
      failure(await http.post(`/orders/${order.id}/received`, {}, buyer.token), 409, 'ORDER_STATE_CHANGED');
    });

    it('cancels a paid order before confirmation and refunds through the provider', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { price: 80_000, stock: 3 });
      const order = await paidOrder(t, buyer, String(product._id));
      expect(await stockOf(product._id)).toBe(2);
      const pendingBefore = data(await http.get('/seller/earnings', sellerA.token)).overview.pending;

      const cancelled = data(await http.post(`/orders/${order.id}/cancel`, { reason: 'Found it cheaper nearby' }, buyer.token));
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelledBy: 'buyer', escrow: { phase: 'refunded', state: 'refunded' } });
      // The provider settles refunds asynchronously; the sandbox does it almost at once.
      expect(['pending', 'processed']).toContain(cancelled.refundStatus);
      await settle(t);
      const after = data(await http.get(`/orders/${order.id}`, buyer.token));
      expect(after).toMatchObject({ refunded: true, refundStatus: 'processed' });
      expect(after.tracking.events[0].label).toBe('Refund completed');
      expect(await stockOf(product._id)).toBe(3);
      expect(data(await http.get('/seller/earnings', sellerA.token)).overview.pending).toBe(pendingBefore - order.total);
    });

    it('lets the buyer only request cancellation once the seller confirmed; the seller decides', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { price: 30_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/confirm`, {}, sellerA.token));
      failure(await http.post(`/orders/${order.id}/cancel`, { reason: 'Changed my mind' }, buyer.token), 409, 'ORDER_STATE_CHANGED');
      expect(data(await http.post(`/orders/${order.id}/request-cancellation`, { reason: 'Changed my mind' }, buyer.token)).cancellationRequested).toBe(true);
      failure(await http.post(`/orders/${order.id}/request-cancellation`, { reason: 'Again' }, buyer.token), 409);
      const cancelled = data(await http.post(`/seller/orders/${order.id}/cancel`, { reason: 'Buyer asked to cancel' }, sellerA.token));
      expect(cancelled).toMatchObject({ status: 'cancelled', cancelledBy: 'seller', cancellationRequested: false });
    });

    it('accepts a meetup handover as delivery', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { delivery: 'meetup' });
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/confirm`, {}, sellerA.token));
      const delivered = data(await http.post(`/seller/orders/${order.id}/deliver`, { note: 'Handed over at Central Park Cafe' }, sellerA.token));
      expect(delivered).toMatchObject({ status: 'delivered', escrow: { phase: 'inspection' } });
    });

    it('filters and searches the order history', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { title: 'Canon EOS R50 Mirrorless' });
      const order = await paidOrder(t, buyer, String(product._id));
      expect(data(await http.get('/orders?status=Pending', buyer.token)).total).toBe(1);
      expect(data(await http.get('/orders?status=All%20Orders', buyer.token)).total).toBe(1);
      expect(data(await http.get('/orders?status=delivered', buyer.token)).total).toBe(0);
      expect(data(await http.get('/orders?q=canon', buyer.token)).total).toBe(1);
      expect(data(await http.get(`/orders?q=${encodeURIComponent(order.number)}`, buyer.token)).total).toBe(1);
      expect(data(await http.get('/orders/recent?limit=4', buyer.token))).toHaveLength(1);
      // The route accepts the reference, with or without '#', and the database id.
      expect(data(await http.get(`/orders/${order.orderId}`, buyer.token)).number).toBe(order.number);
    });

    it('puts a past order back in the cart', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { stock: 10 });
      const order = await paidOrder(t, buyer, String(product._id), 2);
      const result = data(await http.post(`/orders/${order.id}/reorder`, {}, buyer.token));
      expect(result).toMatchObject({ added: 1, skipped: [] });
      expect(result.cart.count).toBe(2);
    });

    it('shows the seller their dashboard tiles', async () => {
      const summary = data(await http.get('/seller/summary', sellerB.token));
      expect(summary).toEqual(
        expect.objectContaining({ revenue: expect.any(Number), totalOrders: expect.any(Number), activeProducts: expect.any(Number), pendingOrders: expect.any(Number) }),
      );
      expect(summary.totalOrders).toBeGreaterThan(0);
      const orders = data(await http.get('/seller/orders', sellerB.token));
      expect(orders.rows[0]).toEqual(expect.objectContaining({ customer: expect.objectContaining({ email: expect.any(String) }), sellerEarning: expect.any(Number) }));
    });
  });

  describe('Buy via Escrow', () => {
    it('quotes the escrow fee and courier fee', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { price: 400_000 });
      const quote = data(await http.get(`/checkout/escrow/${product._id}/quote`, buyer.token));
      expect(quote.quote).toMatchObject({ itemPrice: 400_000, deliveryFee: 5_000, escrowFee: 2_000, total: 407_000 });
    });

    it('charges an accepted offer instead of the listed price, then retires the offer', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { price: 4_200_000 });
      const offer = await model<Offer>(t, Offer.name).create({
        conversationId: new Types.ObjectId(),
        productId: product._id,
        buyerId: new Types.ObjectId(buyer.id),
        sellerId: new Types.ObjectId(sellerA.id),
        amount: 3_800_000,
        listed: 4_200_000,
        status: 'accepted',
        agreedAmount: 3_800_000,
      });
      const checkout = data(await http.post('/checkout/escrow', { productId: String(product._id), method: 'transfer', offerId: String(offer._id), delivery: { ...DELIVERY, zip: '100001' } }, buyer.token));
      expect(checkout.quote).toMatchObject({ itemPrice: 3_800_000, escrowFee: 19_000, total: 3_824_000 });
      expect(checkout.orders[0]).toMatchObject({ kind: 'escrow', escrowFee: 19_000 });
      await payAndVerify(t, buyer, checkout.payment.reference);
      expect((await model<Offer>(t, Offer.name).findById(offer._id).lean())!.status).toBe('used');
      const sellerView = data(await http.get(`/seller/orders/${checkout.orders[0].id}`, sellerA.token));
      expect(sellerView).toMatchObject({ kindLabel: 'Escrow payment', status: 'pending', sellerEarning: 3_805_000 });
    });

    it('refuses offers that were not accepted, and someone else’s offers', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA);
      const pending = await model<Offer>(t, Offer.name).create({ conversationId: new Types.ObjectId(), productId: product._id, buyerId: new Types.ObjectId(buyer.id), sellerId: new Types.ObjectId(sellerA.id), amount: 1, listed: 400_000, status: 'pending' });
      failure(await http.get(`/checkout/escrow/${product._id}/quote?offerId=${pending._id}`, buyer.token), 409, 'OFFER_NOT_ACCEPTED');
      const stranger = await registerUser(t);
      failure(await http.get(`/checkout/escrow/${product._id}/quote?offerId=${pending._id}`, stranger.token), 404, 'OFFER_NOT_FOUND');
    });

    it('is unavailable while escrow is switched off', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA);
      await setSettings(t, 'escrow', { enabled: false });
      failure(await http.post('/checkout/escrow', { productId: String(product._id), method: 'card', delivery: DELIVERY }, buyer.token), 400, 'ESCROW_DISABLED');
      await setSettings(t, 'escrow', { enabled: true });
    });
  });

  describe('saved cards and payout accounts', () => {
    it('saves the card used on the provider page and can pay with it next time', async () => {
      const buyer = await registerUser(t);
      const first = await newProduct(sellerA);
      await paidOrder(t, buyer, String(first._id));
      const accounts = data(await http.get('/me/payment-accounts', buyer.token));
      const card = accounts.find((account: any) => account.type === 'card');
      expect(card).toMatchObject({ issuer: 'Visa', last4: '4081', verified: true, primary: true, expiry: '12/30' });
      expect(JSON.stringify(accounts)).not.toContain('AUTH_');

      const second = await newProduct(sellerA);
      data(await http.post('/cart/items', { productId: String(second._id) }, buyer.token));
      data(await http.put('/cart/delivery', DELIVERY, buyer.token));
      const checkout = data(await http.post('/checkout', { method: 'card', savedCardId: card.id }, buyer.token));
      expect(checkout.payment.status).toBe('paid');
      await settle(t);
      expect(data(await http.get(`/orders/${checkout.orders[0].id}`, buyer.token)).status).toBe('pending');
    });

    it('adds bank accounts the bank confirms, never storing the full number', async () => {
      const resolved = data(await http.post('/payments/banks/resolve', { bankCode: '058', accountNumber: '0123456789' }, sellerA.token));
      expect(resolved).toEqual({ accountName: 'DOOAA SANDBOX 6789', bankName: 'Guaranty Trust Bank', bankCode: '058', last4: '6789' });
      failure(await http.post('/payments/banks/resolve', { bankCode: '058', accountNumber: '0000000000' }, sellerA.token), 400, 'ACCOUNT_NOT_RESOLVED');

      const account = data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '058', accountNumber: '0123456789' }, sellerA.token));
      expect(account).toMatchObject({ type: 'bank', issuer: 'Guaranty Trust Bank', holder: 'DOOAA SANDBOX 6789', last4: '6789', verified: true, primary: true });
      expect(JSON.stringify(await t.connection.collection('payout_accounts').findOne({}))).not.toContain('0123456789');

      failure(await http.post('/me/payment-accounts', { type: 'card' }, sellerA.token), 400, 'CARD_ENTRY_NOT_SUPPORTED');
      failure(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '058', accountNumber: '0123456789', cvv: '123' }, sellerA.token), 400, 'VALIDATION_FAILED');
      expect((await http.get('/payments/banks')).body.data.length).toBeGreaterThan(10);
    });

    it('switches the primary account and promotes another when the primary is removed', async () => {
      const seller = await registerSeller(t);
      const first = data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '044', accountNumber: '1111111111' }, seller.token));
      const second = data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '057', accountNumber: '2222222222' }, seller.token));
      expect(second.primary).toBe(false);
      data(await http.post(`/me/payment-accounts/${second.id}/primary`, {}, seller.token));
      let accounts = data(await http.get('/me/payment-accounts', seller.token));
      expect(accounts.find((row: any) => row.id === second.id).primary).toBe(true);
      data(await http.delete(`/me/payment-accounts/${second.id}`, seller.token));
      accounts = data(await http.get('/me/payment-accounts', seller.token));
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ id: first.id, primary: true });
    });
  });

  describe('payouts', () => {
    async function sellerWithBalance(amount = 100_000) {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id, { price: amount - 5_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      await completeOrder(t, buyer, seller, order.id);
      return seller;
    }

    it('withdraws to the primary bank through a provider transfer', async () => {
      const seller = await sellerWithBalance(100_000);
      data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '058', accountNumber: '0123456789' }, seller.token));
      expect(data(await http.get('/seller/earnings', seller.token)).overview).toEqual({ available: 100_000, pending: 0, withdrawn: 0 });

      failure(await http.post('/seller/payouts', { amount: 500, password: 'Dooaa@123' }, seller.token), 400, 'BELOW_MINIMUM_WITHDRAWAL');
      failure(await http.post('/seller/payouts', { amount: 200_000, password: 'Dooaa@123' }, seller.token), 400, 'INSUFFICIENT_BALANCE');
      failure(await http.post('/seller/payouts', { amount: 50_000, password: 'Wrong@123' }, seller.token), 400, 'INVALID_PASSWORD');
      failure(await http.post('/seller/payouts', { amount: 50_000, password: 'Dooaa@123', destination: 'paypal' }, seller.token), 400, 'PAYOUT_METHOD_UNAVAILABLE');

      const payout = data(await http.post('/seller/payouts', { amount: 60_000, password: 'Dooaa@123' }, seller.token));
      expect(payout).toMatchObject({ amount: 60_000, status: 'processing', destination: 'Bank Account', bankName: 'Guaranty Trust Bank', last4: '6789' });
      expect(data(await http.get('/seller/earnings', seller.token)).overview.available).toBe(40_000);
      await settle(t);
      const after = data(await http.get('/seller/earnings', seller.token));
      expect(after.overview).toEqual({ available: 40_000, pending: 0, withdrawn: 60_000 });
      expect(after.payouts.rows[0]).toMatchObject({ status: 'completed' });
      expect(await t.get<WalletService>(WalletService).recompute(seller.id)).toEqual(after.overview);
    });

    it('needs a payout account', async () => {
      const seller = await sellerWithBalance(20_000);
      failure(await http.post('/seller/payouts', { amount: 10_000, password: 'Dooaa@123' }, seller.token), 400, 'NO_PAYOUT_ACCOUNT');
    });

    it('returns the money to the balance when the transfer fails', async () => {
      const seller = await sellerWithBalance(30_000);
      data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '044', accountNumber: '1234569999' }, seller.token));
      data(await http.post('/seller/payouts', { amount: 30_000, password: 'Dooaa@123' }, seller.token));
      await settle(t);
      const after = data(await http.get('/seller/earnings', seller.token));
      expect(after.overview).toEqual({ available: 30_000, pending: 0, withdrawn: 0 });
      expect(after.payouts.rows[0]).toMatchObject({ status: 'failed', failureReason: 'Beneficiary bank unavailable' });
    });

    it('never pays the same balance out twice under concurrent requests', async () => {
      const seller = await sellerWithBalance(50_000);
      data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '058', accountNumber: '0123456780' }, seller.token));
      const attempts = await Promise.all(Array.from({ length: 4 }, () => http.post('/seller/payouts', { amount: 40_000, password: 'Dooaa@123' }, seller.token)));
      expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
      await settle(t);
      expect(data(await http.get('/seller/earnings', seller.token)).overview).toEqual({ available: 10_000, pending: 0, withdrawn: 40_000 });
    });

    it('lets the console see payouts and retry failed ones', async () => {
      const seller = await sellerWithBalance(25_000);
      data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '044', accountNumber: '5555559999' }, seller.token));
      const payout = data(await http.post('/seller/payouts', { amount: 25_000, password: 'Dooaa@123' }, seller.token));
      await settle(t);
      // The seller fixes their bank details; the console retries.
      data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '058', accountNumber: '0123456781', primary: true }, seller.token));
      const admin = await staffToken(t, 'admin');
      const failed = data(await http.get('/admin/payouts?status=failed', admin.token));
      expect(failed.rows.map((row: any) => row.id)).toContain(payout.id);
      const retried = data(await http.post(`/admin/payouts/${payout.id}/retry`, {}, admin.token));
      expect(retried.status).toBe('processing');
      await settle(t);
      expect(data(await http.get('/seller/earnings', seller.token)).overview).toEqual({ available: 0, pending: 0, withdrawn: 25_000 });
    });
  });

  describe('console escrow ledger', () => {
    it('lists transactions with search, status filter and the four-step timeline', async () => {
      const buyer = await registerUser(t, { firstName: 'Melissa', lastName: 'Jones' });
      const product = await newProduct(sellerA, { title: 'Handmade Ceramics' });
      const order = await paidOrder(t, buyer, String(product._id));
      const admin = await staffToken(t, 'admin');
      const page = data(await http.get('/admin/escrows?search=Melissa&status=pending', admin.token));
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        reference: order.escrow.reference,
        status: 'pending',
        buyerName: 'Melissa Jones',
        item: 'Handmade Ceramics',
        paymentMethod: 'Credit Card',
        amount: order.total,
      });
      expect(page.rows[0].timeline.map((step: any) => `${step.stage}:${step.state}`)).toEqual(['secured:done', 'shipped:pending', 'received:pending', 'released:pending']);
      expect(page.pageSize).toBe(8);
      expect(data(await http.get(`/admin/escrows/${order.orderId}`, admin.token)).orderNumber).toBe(order.number);
    });

    it('enforces who may release, refund, force-release and reverse', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA, { price: 45_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      const moderator = await staffToken(t, 'moderator');
      const admin = await staffToken(t, 'admin');
      failure(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'released' }, moderator.token), 403, 'PERMISSION_DENIED');
      failure(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'force-released' }, admin.token), 403, 'PERMISSION_DENIED');
      const released = data(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'released', note: 'Buyer confirmed by phone' }, admin.token));
      expect(released).toMatchObject({ status: 'completed', settlement: 'released' });
      expect(released.transaction.timeline.every((step: any) => step.state === 'done')).toBe(true);
      failure(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'refunded' }, admin.token), 409, 'INVALID_SETTLEMENT');
      const log = data(await http.get('/admin/audit?targetType=escrow', admin.token));
      expect(log.rows[0].action).toBe('Approved release of escrow funds');
    });

    it('lets a superadmin force-release a disputed payment and reverse a release', async () => {
      const buyer = await registerUser(t);
      const seller = await registerSeller(t);
      const product = await createProduct(t, seller.id, { price: 70_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'DHL Express', trackingNumber: 'DHL-55' }, seller.token));
      const orders = t.get<OrdersService>(OrdersService);
      await orders.markDisputed(new Types.ObjectId(order.orderId), new Types.ObjectId(), { kind: 'buyer', id: buyer.id, name: 'Buyer' }, 'Not as described');
      const superadmin = await staffToken(t, 'superadmin');

      failure(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'released' }, superadmin.token), 409, 'INVALID_SETTLEMENT');
      const forced = data(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'force-released' }, superadmin.token));
      expect(forced).toMatchObject({ status: 'completed', settlement: 'force-released' });
      await settle(t);
      // The courier fee is part of the seller's earning: 70,000 + 5,000.
      expect(data(await http.get('/seller/earnings', seller.token)).overview.available).toBe(75_000);

      const reversed = data(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'reversed', note: 'Evidence came in late' }, superadmin.token));
      expect(reversed).toMatchObject({ status: 'dispute', settlement: 'reversed' });
      expect(data(await http.get('/seller/earnings', seller.token)).overview).toMatchObject({ available: 0, pending: 75_000 });
      const log = data(await http.get('/admin/audit?targetType=escrow', superadmin.token));
      expect(log.rows.slice(0, 2).every((row: any) => row.elevated)).toBe(true);
    });

    it('cannot reverse money the seller already withdrew, or a refund', async () => {
      const buyer = await registerUser(t);
      const seller = await registerSeller(t);
      const product = await createProduct(t, seller.id, { price: 35_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      await completeOrder(t, buyer, seller, order.id);
      data(await http.post('/me/payment-accounts', { type: 'bank', bankCode: '058', accountNumber: '0123456782' }, seller.token));
      data(await http.post('/seller/payouts', { amount: 40_000, password: 'Dooaa@123' }, seller.token));
      await settle(t);
      const superadmin = await staffToken(t, 'superadmin');
      failure(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'reversed' }, superadmin.token), 409, 'FUNDS_WITHDRAWN');

      const refundedOrder = await paidOrder(t, buyer, String((await createProduct(t, seller.id))._id));
      data(await http.post(`/admin/escrows/${refundedOrder.orderId}/settle`, { settlement: 'refunded', note: 'Seller unreachable' }, superadmin.token));
      failure(await http.post(`/admin/escrows/${refundedOrder.orderId}/settle`, { settlement: 'reversed' }, superadmin.token), 409);
    });

    it('blocks force-release and reversal while escrow is off', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA);
      const order = await paidOrder(t, buyer, String(product._id));
      const superadmin = await staffToken(t, 'superadmin');
      await setSettings(t, 'escrow', { enabled: false });
      failure(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'force-released' }, superadmin.token), 409, 'ESCROW_DISABLED');
      await setSettings(t, 'escrow', { enabled: true });
    });
  });

  describe('background jobs', () => {
    it('releases funds when the inspection window closes', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerB, { price: 15_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'UPS', trackingNumber: '1Z999' }, sellerB.token));
      data(await http.post(`/orders/${order.id}/received`, {}, buyer.token));
      await model<Order>(t, Order.name).updateOne({ _id: order.orderId }, { $set: { 'escrow.inspectionEndsAt': new Date(Date.now() - 1000) } });
      expect(await t.get<OrdersService>(OrdersService).autoRelease()).toBeGreaterThanOrEqual(1);
      expect(data(await http.get(`/orders/${order.id}`, buyer.token)).escrow).toMatchObject({ phase: 'released', settlement: 'released' });
    });

    it('cancels and refunds orders the seller never shipped', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerB);
      const order = await paidOrder(t, buyer, String(product._id));
      await model<Order>(t, Order.name).updateOne({ _id: order.orderId }, { $set: { shipBy: new Date(Date.now() - 100 * 3_600_000) } });
      expect(await t.get<OrdersService>(OrdersService).cancelOverdue()).toBeGreaterThanOrEqual(1);
      expect(data(await http.get(`/orders/${order.id}`, buyer.token))).toMatchObject({ status: 'cancelled', cancelledBy: 'system' });
    });

    it('lets an overdue order be cancelled by the buyer even after confirmation', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerB);
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/confirm`, {}, sellerB.token));
      await model<Order>(t, Order.name).updateOne({ _id: order.orderId }, { $set: { shipBy: new Date(Date.now() - 1000) } });
      expect(data(await http.get(`/orders/${order.id}`, buyer.token)).actions).toContain('cancel');
      data(await http.post(`/orders/${order.id}/cancel`, { reason: 'Seller has not shipped' }, buyer.token));
    });
  });

  describe('closing an account', () => {
    it('is refused while orders are open or money is owed', async () => {
      const buyer = await registerUser(t);
      const product = await newProduct(sellerA);
      await paidOrder(t, buyer, String(product._id));
      failure(await http.post('/me/close', { reason: "I'm not currently buying or selling anything", password: 'Dooaa@123' }, buyer.token), 409, 'OPEN_ORDERS');
    });

    it('closes an idle account and signs it out everywhere', async () => {
      const user = await registerUser(t);
      failure(await http.post('/me/close', { reason: 'Not a listed reason', password: 'Dooaa@123' }, user.token), 400, 'VALIDATION_FAILED');
      failure(await http.post('/me/close', { reason: "I don't recall creating an account", password: 'Wrong@123' }, user.token), 400, 'INVALID_PASSWORD');
      data(await http.post('/me/close', { reason: "I don't recall creating an account", notes: 'Testing', password: 'Dooaa@123' }, user.token));
      failure(await http.get('/me', user.token), 401, 'ACCOUNT_CLOSED');
      failure(await http.post('/auth/sign-in', { email: user.email, password: 'Dooaa@123' }), 401, 'ACCOUNT_CLOSED');
    });
  });
});
