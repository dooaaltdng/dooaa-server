import { createTestApp, type TestApp } from './utils/app';
import { Http, data, failure } from './utils/http';
import { eventually } from './utils/eventually';
import { createProduct, model, registerSeller, registerUser, staffToken, uploadImage, type TestUser } from './utils/factories';
import { DELIVERY, completeOrder, paidOrder, payAndVerify, settle } from './utils/commerce';
import { Product } from '../src/modules/products/schemas/product.schema';
import { Order } from '../src/modules/orders/schemas/order.schema';
import { JobsService } from '../src/modules/jobs/jobs.service';

describe('Console users, content, dashboard, support and jobs (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let superadmin: Awaited<ReturnType<typeof staffToken>>;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    superadmin = await staffToken(t, 'superadmin');
  });
  afterAll(async () => t.close());

  describe('user management', () => {
    it('lists buyers and sellers with search, filters and the table’s page size', async () => {
      const buyer = await registerUser(t, { firstName: 'Alex', lastName: 'Johnson', location: 'Port Harcourt' });
      const seller = await registerSeller(t, { storeName: 'Johnson Gadgets' });
      await createProduct(t, seller.id);
      await t.get<any>(require('../src/modules/products/products.service').ProductsService).recountActiveListings(seller.id);

      const buyers = data(await http.get('/admin/buyers?search=alex%20johnson', superadmin.token));
      expect(buyers.rows).toHaveLength(1);
      expect(buyers.rows[0]).toMatchObject({ id: buyer.id, name: 'Alex Johnson', email: buyer.email, status: 'active', region: 'Rivers', totalPurchase: 0 });
      expect(buyers.pageSize).toBe(7);
      expect(data(await http.get('/admin/buyers?regions=Rivers&statuses=active', superadmin.token)).rows.map((row: any) => row.id)).toContain(buyer.id);
      expect(data(await http.get('/admin/buyers?regions=Kano', superadmin.token)).rows.map((row: any) => row.id)).not.toContain(buyer.id);

      const sellers = data(await http.get('/admin/sellers?search=Johnson%20Gadgets&minCount=1', superadmin.token));
      expect(sellers.rows[0]).toMatchObject({ id: seller.id, storeName: 'Johnson Gadgets', activeListings: 1, verification: 'normal' });
      expect(data(await http.get('/admin/sellers?maxCount=0&search=Johnson%20Gadgets', superadmin.token)).total).toBe(0);
      expect(data(await http.get('/admin/sellers', superadmin.token)).rows.some((row: any) => row.email === 'store@dooaa.ng')).toBe(false);
    });

    it('builds the buyer profile from real orders and disputes', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id, { title: 'Canon EOS R50' });
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'UPS', trackingNumber: 'UPS-1' }, seller.token));
      data(await http.post(`/orders/${order.id}/dispute`, { reason: 'The kit lens was missing from the box.' }, buyer.token));

      const profile = data(await http.get(`/admin/buyers/${buyer.id}`, superadmin.token));
      expect(profile).toMatchObject({ kycLevel: 1, kycHeadline: 'Level 1 — Awaiting ID', totalPurchase: 1 });
      expect(profile.transactions[0]).toMatchObject({ orderId: order.number, item: 'Canon EOS R50', sellerEmail: seller.email, status: 'shipped' });
      expect(profile.disputes[0]).toMatchObject({ orderId: order.number, status: 'review' });
      expect(profile.messages[0]).toMatchObject({ reference: profile.disputes[0].reference });
      failure(await http.get(`/admin/buyers/${seller.id}`, superadmin.token), 404, 'USER_NOT_FOUND');
    });

    it('builds the seller profile with listings, sales and KYC documents', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id, { title: 'PlayStation 5 Slim' });
      const order = await paidOrder(t, buyer, String(product._id));
      await completeOrder(t, buyer, seller, order.id);
      const profile = data(await http.get(`/admin/sellers/${seller.id}`, superadmin.token));
      expect(profile).toMatchObject({ listingCount: 1, soldCount: 1, documents: [], verificationStatus: null });
      expect(profile.listings[0]).toMatchObject({ product: 'PlayStation 5 Slim' });
      expect(profile.sold[0]).toMatchObject({ item: 'PlayStation 5 Slim', orderId: order.number, salePrice: order.total });
    });

    it('suspends, bans and restores accounts with the right permissions, hiding a seller’s listings meanwhile', async () => {
      const seller = await registerSeller(t);
      const product = await createProduct(t, seller.id, { title: 'Restricted Seller Item' });
      const moderator = await staffToken(t, 'moderator');

      failure(await http.patch(`/admin/users/${seller.id}/status`, { status: 'banned' }, moderator.token), 403, 'PERMISSION_DENIED');
      expect(data(await http.patch(`/admin/users/${seller.id}/status`, { status: 'suspended', reason: 'Reported listings' }, moderator.token))).toEqual({ id: seller.id, status: 'suspended' });
      failure(await http.get(`/products/${product._id}`), 404);
      failure(await http.get('/seller/products', seller.token), 403, 'ACCOUNT_SUSPENDED');

      data(await http.patch(`/admin/users/${seller.id}/status`, { status: 'active' }, moderator.token));
      expect(data(await http.get(`/products/${product._id}`)).title).toBe('Restricted Seller Item');

      const admin = await staffToken(t, 'admin');
      data(await http.patch(`/admin/users/${seller.id}/status`, { status: 'banned' }, admin.token));
      failure(await http.post('/auth/sign-in', { email: seller.email, password: 'Dooaa@123' }), 403, 'ACCOUNT_BANNED');
      await t.mail.idle();
      expect(t.mail.lastTo(seller.email)?.subject).toBe('Your DOOAA account has been banned');
      const log = data(await http.get('/admin/audit?targetType=user', admin.token));
      expect(log.rows.map((row: any) => row.action)).toEqual(expect.arrayContaining(['Suspended an account', 'Restored an account', 'Banned an account']));
    });

    it('sets a seller’s verification level', async () => {
      const seller = await registerSeller(t);
      expect(data(await http.patch(`/admin/sellers/${seller.id}/verification-level`, { level: 'high-value' }, superadmin.token))).toEqual({ id: seller.id, verificationLevel: 'high-value' });
      expect(data(await http.get('/auth/me', seller.token)).verificationLevel).toBe('high-value');
    });

    it('verifies a seller manually, which needs users.verify and marks their listings verified', async () => {
      const seller = await registerSeller(t, { verifiedIdentity: false });
      const product = await createProduct(t, seller.id, { sellerVerified: false });
      const buyer = await registerUser(t);
      const moderator = await staffToken(t, 'moderator');

      failure(await http.post(`/admin/sellers/${seller.id}/verify`, {}, moderator.token), 403, 'PERMISSION_DENIED');
      failure(await http.post(`/admin/sellers/${buyer.id}/verify`, {}, superadmin.token), 404, 'USER_NOT_FOUND');

      expect(data(await http.post(`/admin/sellers/${seller.id}/verify`, {}, superadmin.token))).toEqual({ id: seller.id, identity: 'verified' });
      expect(data(await http.get('/auth/me', seller.token)).identity).toBe('verified');
      expect((await model<Product>(t, Product.name).findById(product._id).lean())?.sellerVerified).toBe(true);
      await t.mail.idle();
      expect(t.mail.lastTo(seller.email)?.subject).toBe('Your DOOAA identity is verified');
      // Idempotent: a second click changes nothing and sends nothing new.
      expect(data(await http.post(`/admin/sellers/${seller.id}/verify`, {}, superadmin.token)).identity).toBe('verified');
      const log = data(await http.get(`/admin/audit?search=${encodeURIComponent('Verified a seller manually')}`, superadmin.token));
      expect(log.rows).toHaveLength(1);
    });

    it('limits how many listings a seller can have live, and lifts the limit', async () => {
      const seller = await registerSeller(t);
      await createProduct(t, seller.id, { title: 'Already live' });
      const image = await uploadImage(t, seller.token);
      const listing = {
        title: 'Sony WH-1000XM5',
        description: 'Noise cancelling headphones, barely used, with the case.',
        price: 350_000,
        pricing: 'fixed',
        condition: 'slightly-used',
        stock: 1,
        categoryId: 'gatdgets',
        delivery: 'nationwide',
        paymentMethod: 'default',
        images: [image],
        publish: true,
      };

      const limited = data(await http.patch(`/admin/sellers/${seller.id}/listing-limit`, { limit: 1 }, superadmin.token));
      expect(limited).toEqual({ id: seller.id, listingLimit: 1 });
      expect(data(await http.get(`/admin/sellers/${seller.id}`, superadmin.token)).listingLimit).toBe(1);
      await t.mail.idle();
      expect(t.mail.lastTo(seller.email)?.subject).toBe('A listing limit has been set on your DOOAA store');

      const blocked = failure(await http.post('/seller/products', listing, seller.token), 403, 'LISTING_LIMIT_REACHED');
      expect(blocked.error).toContain('up to 1 live listing');
      // Drafts are still allowed; publishing one is what the limit stops.
      const draft = data(await http.post('/seller/products', { ...listing, publish: false }, seller.token));
      failure(await http.patch(`/seller/products/${draft.id}/status`, { status: 'active' }, seller.token), 403, 'LISTING_LIMIT_REACHED');

      failure(await http.patch(`/admin/sellers/${seller.id}/listing-limit`, { limit: -1 }, superadmin.token), 400, 'VALIDATION_FAILED');
      data(await http.patch(`/admin/sellers/${seller.id}/listing-limit`, { limit: null }, superadmin.token));
      expect(data(await http.patch(`/seller/products/${draft.id}/status`, { status: 'active' }, seller.token)).status).not.toBe('draft');
      const log = data(await http.get('/admin/audit?targetType=user', superadmin.token));
      expect(log.rows.map((row: any) => row.action)).toEqual(expect.arrayContaining(['Limited a seller to 1 live listing', "Lifted a seller's listing limit"]));
    });

    it('changes an account’s email, telling both addresses and asking for confirmation again', async () => {
      const buyer = await registerUser(t);
      const other = await registerUser(t);
      const admin = await staffToken(t, 'admin');
      const moderator = await staffToken(t, 'moderator');
      const next = `moved.${Date.now()}@example.com`;

      failure(await http.patch(`/admin/users/${buyer.id}/email`, { email: next }, moderator.token), 403, 'PERMISSION_DENIED');
      failure(await http.patch(`/admin/users/${buyer.id}/email`, { email: 'not-an-email' }, admin.token), 400, 'VALIDATION_FAILED');
      failure(await http.patch(`/admin/users/${buyer.id}/email`, { email: other.email }, admin.token), 409, 'EMAIL_TAKEN');

      expect(data(await http.patch(`/admin/users/${buyer.id}/email`, { email: `  ${next.toUpperCase()} ` }, admin.token))).toEqual({ id: buyer.id, email: next, emailVerified: false });
      await t.mail.idle();
      expect(t.mail.lastTo(buyer.email)?.subject).toBe('Your DOOAA email address was changed');
      expect(t.mail.lastTo(next)?.subject).toBe('Confirm your new DOOAA email address');
      const me = data(await http.get('/auth/me', buyer.token));
      expect(me).toMatchObject({ email: next, verified: false });
      // The new address signs in; the old one no longer does.
      data(await http.post('/auth/sign-in', { email: next, password: buyer.password }));
      failure(await http.post('/auth/sign-in', { email: buyer.email, password: buyer.password }), 401);
    });
  });

  describe('console search', () => {
    it('finds accounts, listings, escrow transactions and disputes from one box', async () => {
      const seller = await registerSeller(t, { storeName: 'Zainab Gadget Hub' });
      const buyer = await registerUser(t, { firstName: 'Zainab', lastName: 'Yusuf' });
      const product = await createProduct(t, seller.id, { title: 'Zainab Special Edition Speaker' });
      const order = await paidOrder(t, buyer, String(product._id));
      data(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'GIG', trackingNumber: 'GIG-1' }, seller.token));
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'Zainab speaker does not power on at all.' }, buyer.token));
      const moderator = await staffToken(t, 'moderator');

      const hits = data(await http.get('/admin/search?q=zainab', moderator.token));
      expect(hits.users.map((row: any) => row.id)).toEqual(expect.arrayContaining([seller.id, buyer.id]));
      expect(hits.users.find((row: any) => row.id === seller.id)).toMatchObject({ role: 'seller', href: `/users/sellers/${seller.id}` });
      expect(hits.listings[0]).toMatchObject({ id: String(product._id), sellerName: 'Zainab Gadget Hub', href: `/listings?item=${product._id}` });
      expect(hits.transactions.map((row: any) => row.id)).toContain(order.orderId);
      expect(hits.disputes[0]).toMatchObject({ id: dispute.id, href: `/disputes?id=${dispute.id}` });

      const byReference = data(await http.get(`/admin/search?q=${encodeURIComponent(dispute.reference)}`, moderator.token));
      expect(byReference.disputes.map((row: any) => row.id)).toContain(dispute.id);
      const byPhone = data(await http.get(`/admin/search?q=${buyer.phone.slice(-6)}`, moderator.token));
      expect(byPhone.users.map((row: any) => row.id)).toContain(buyer.id);

      expect(data(await http.get('/admin/search?q=z', moderator.token))).toEqual({ users: [], listings: [], transactions: [], disputes: [] });
      expect(data(await http.get(`/admin/search?q=${encodeURIComponent('.*(')}`, moderator.token)).users).toEqual([]);
      failure(await http.get('/admin/search?q=zainab'), 401);
    });
  });

  describe('content', () => {
    it('serves the six published pages, including under the client’s route names', async () => {
      const pages = data(await http.get('/content'));
      expect(pages.map((page: any) => page.title)).toEqual(['About Us', 'Help Center', 'Privacy Policy', 'Terms & Conditions', 'Refund & Return Policy', 'Safety Tips for Transactions']);
      expect(data(await http.get('/content/refund-policy')).slug).toBe('refunds');
      expect(data(await http.get('/content/safety-tips')).body).toContain('<h2>');
      failure(await http.get('/content/nope'), 404, 'PAGE_NOT_FOUND');
    });

    it('publishes sanitised copy, keeps history and restores a version', async () => {
      const original = data(await http.get('/admin/content/about', superadmin.token));
      const published = data(
        await http.post('/admin/content/about/publish', { body: '<h2>About DOOAA</h2><p>Hello<script>alert(1)</script></p>', note: 'New intro' }, superadmin.token),
      );
      expect(published.page.body).toBe('<h2>About DOOAA</h2><p>Hello</p>');
      expect(published.version).toMatchObject({ note: 'New intro', author: 'Nelson Doe' });
      expect(data(await http.get('/content/about')).body).toBe('<h2>About DOOAA</h2><p>Hello</p>');

      data(await http.post('/admin/content/about/publish', { body: '<p>Second edit</p>' }, superadmin.token));
      const history = data(await http.get('/admin/content/about/history', superadmin.token));
      expect(history.map((version: any) => version.body)).toEqual(['<p>Second edit</p>', '<h2>About DOOAA</h2><p>Hello</p>']);
      data(await http.post(`/admin/content/about/versions/${history[1].id}/restore`, {}, superadmin.token));
      expect(data(await http.get('/content/about')).body).toBe('<h2>About DOOAA</h2><p>Hello</p>');
      failure(await http.post('/admin/content/about/publish', { body: '<script></script>' }, superadmin.token), 400, 'EMPTY_PAGE');
      expect(original.title).toBe('About Us');
    });

    it('needs content.publish', async () => {
      const moderator = await staffToken(t, 'moderator');
      failure(await http.post('/admin/content/help/publish', { body: '<p>x</p>' }, moderator.token), 403, 'PERMISSION_DENIED');
    });
  });

  describe('dashboard and analytics', () => {
    it('counts visits once per visitor per day', async () => {
      expect(data(await http.post('/analytics/visit', { visitorId: 'visitor-abc-123' }))).toEqual({ counted: true });
      expect(data(await http.post('/analytics/visit', { visitorId: 'visitor-abc-123' }))).toEqual({ counted: false });
      expect(data(await http.post('/analytics/visit', { visitorId: 'visitor-xyz-789' }))).toEqual({ counted: true });
      failure(await http.post('/analytics/visit', { visitorId: 'bad id!' }), 400, 'VALIDATION_FAILED');
      const activity = data(await http.get('/admin/dashboard/trends/activity?range=7d', superadmin.token));
      expect(activity).toMatchObject({ id: 'activity', title: 'Site Activity', unit: 'count', total: 2, headline: '2 Visits' });
      expect(activity.points).toHaveLength(7);
      expect(activity.points.at(-1).current).toBe(2);
    });

    it('shows live metric tiles and transaction volume', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id, { price: 95_000 });
      await paidOrder(t, buyer, String(product._id));
      const metrics = data(await http.get('/admin/dashboard/metrics', superadmin.token));
      expect(metrics.map((metric: any) => metric.id)).toEqual(['buyers', 'sellers', 'items', 'transactions']);
      expect(metrics[0].value).toBeGreaterThan(0);
      expect(metrics[3].value).toBeGreaterThan(0);
      const volume = data(await http.get('/admin/dashboard/trends/transactions?range=30d', superadmin.token));
      expect(volume).toMatchObject({ id: 'transactions', unit: 'money' });
      expect(volume.total).toBeGreaterThanOrEqual(100_000);
      expect(volume.headline).toMatch(/^₦/);
      expect(volume.badge).toMatch(/^Last 30 Days [+-]/);
      failure(await http.get('/admin/dashboard/trends/nonsense', superadmin.token), 400, 'VALIDATION_FAILED');
    });

    it('gives the seller revenue against the last period, orders by status and store views', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id, { price: 50_000 });
      data(await http.get(`/products/${product._id}`, buyer.token));
      await paidOrder(t, buyer, String(product._id));
      // The view is counted just after the product page is answered.
      const analytics = await eventually(async () => {
        const page = data(await http.get('/seller/analytics?range=7d', seller.token));
        expect(page.views).toBe(1);
        return page;
      });
      expect(analytics.revenue).toHaveLength(7);
      expect(analytics.revenue.at(-1).current).toBe(55_000);
      expect(analytics.totals).toMatchObject({ revenue: 55_000, orders: 1 });
      expect(analytics.views).toBe(1);
      expect(analytics.ordersByStatus).toEqual([
        { status: 'delivered', count: 0 },
        { status: 'shipped', count: 0 },
        { status: 'cancelled', count: 0 },
      ]);
      expect(data(await http.get('/seller/analytics', seller.token)).revenue).toHaveLength(12);
    });
  });

  describe('support', () => {
    it('takes a guest’s message, emails the support inbox and replies to the sender', async () => {
      const ticket = data(await http.post('/support/tickets', { topic: 'Payment or escrow', detail: 'I paid but my order still shows awaiting payment.', name: 'Ada Guest', email: 'ada.guest@example.com' }));
      expect(ticket).toMatchObject({ topic: 'Payment or escrow', status: 'open', email: 'ada.guest@example.com' });
      expect(ticket.reference).toMatch(/^#SUP-\d+$/);
      await t.mail.idle();
      expect(t.mail.lastTo('support@dooaa.ng')?.replyTo).toBe('ada.guest@example.com');
      expect(t.mail.lastTo('ada.guest@example.com')?.subject).toContain(ticket.reference);
      failure(await http.post('/support/tickets', { topic: 'Payment or escrow', detail: 'Too short' }), 400, 'VALIDATION_FAILED');
      failure(await http.post('/support/tickets', { topic: 'Payment or escrow', detail: 'A long enough message without contact details.' }), 400, 'CONTACT_REQUIRED');
    });

    it('uses the account for signed-in senders and lets staff resolve tickets', async () => {
      const user = await registerUser(t);
      const photo = await uploadImage(t, user.token, 'support');
      const ticket = data(await http.post('/support/tickets', { topic: 'Delivery and shipping', detail: 'The courier says the address is wrong, please help.', orderId: '123-456789012', attachments: [photo] }, user.token));
      expect(ticket).toMatchObject({ email: user.email, orderReference: '123-456789012', attachments: [photo] });
      const list = data(await http.get('/admin/support/tickets?status=open', superadmin.token));
      expect(list.rows.map((row: any) => row.id)).toContain(ticket.id);
      expect(data(await http.patch(`/admin/support/tickets/${ticket.id}`, { status: 'resolved' }, superadmin.token)).status).toBe('resolved');
    });
  });

  describe('account summary and jobs', () => {
    it('counts the dashboard tiles and header badges in one call', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id);
      await paidOrder(t, buyer, String(product._id));
      data(await http.put(`/wishlist/${String((await createProduct(t, seller.id))._id)}`, {}, buyer.token));
      data(await http.post('/cart/items', { productId: String((await createProduct(t, seller.id))._id), quantity: 2 }, buyer.token));
      await settle(t);
      const summary = data(await http.get('/me/summary', buyer.token));
      expect(summary).toMatchObject({ orders: 1, wishlist: 1, cart: 2, messages: expect.any(Number), notifications: expect.any(Number) });
      expect(summary.messages).toBeGreaterThanOrEqual(1);
    });

    it('lapses unpaid checkouts after the window, returning their stock', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id, { stock: 3 });
      data(await http.post('/cart/items', { productId: String(product._id), quantity: 2 }, buyer.token));
      data(await http.put('/cart/delivery', DELIVERY, buyer.token));
      const checkout = data(await http.post('/checkout', { method: 'transfer' }, buyer.token));
      expect((await model<Product>(t, Product.name).findById(product._id).lean())!.stock).toBe(1);
      const jobs = t.get<JobsService>(JobsService);
      const result = await jobs.paymentsJob(new Date(Date.now() + 2 * 3_600_000));
      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect((await model<Product>(t, Product.name).findById(product._id).lean())!.stock).toBe(3);
      expect((await model<Order>(t, Order.name).findById(checkout.orders[0].orderId).lean())!.status).toBe('cancelled');
    });

    it('does not lapse a checkout the provider says was paid', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id);
      data(await http.post('/cart/items', { productId: String(product._id) }, buyer.token));
      data(await http.put('/cart/delivery', DELIVERY, buyer.token));
      const checkout = data(await http.post('/checkout', { method: 'card' }, buyer.token));
      // Paid at the provider, but our webhook and the verify call never arrived.
      await t.get<any>(require('../src/modules/payments/providers/payment-provider').PAYMENT_PROVIDER).complete(checkout.payment.reference, 'success');
      await t.get<JobsService>(JobsService).paymentsJob(new Date(Date.now() + 2 * 3_600_000));
      await settle(t);
      expect((await model<Order>(t, Order.name).findById(checkout.orders[0].orderId).lean())!.status).toBe('pending');
    });

    it('lets settings managers run the jobs on demand', async () => {
      const moderator = await staffToken(t, 'moderator');
      failure(await http.post('/admin/system/jobs/run', {}, moderator.token), 403, 'PERMISSION_DENIED');
      const result = data(await http.post('/admin/system/jobs/run', {}, superadmin.token));
      expect(result).toEqual({ payments: expect.any(Object), escrow: expect.any(Object) });
    });

    it('keeps the full order through escrow purchase for a returning buyer', async () => {
      const seller = await registerSeller(t);
      const buyer: TestUser = await registerUser(t);
      const product = await createProduct(t, seller.id, { price: 10_000 });
      const checkout = data(await http.post('/checkout/escrow', { productId: String(product._id), method: 'card', delivery: DELIVERY }, buyer.token));
      await payAndVerify(t, buyer, checkout.payment.reference);
      expect(data(await http.get('/me/summary', buyer.token)).orders).toBe(1);
    });
  });
});
