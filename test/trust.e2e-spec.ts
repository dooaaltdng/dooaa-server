import request from 'supertest';
import { createTestApp, type TestApp } from './utils/app';
import { API, Http, data, failure } from './utils/http';
import { codeFromMail, createProduct, model, registerSeller, registerUser, staffToken, uploadImage, type TestUser } from './utils/factories';
import { completeOrder, paidOrder, settle } from './utils/commerce';
import { FILES } from './utils/files';
import { Product } from '../src/modules/products/schemas/product.schema';
import { User } from '../src/modules/users/schemas/user.schema';

describe('Reviews, identity verification and disputes (e2e)', () => {
  let t: TestApp;
  let http: Http;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
  });
  afterAll(async () => t.close());

  async function kycUpload(token: string, buffer = FILES.jpeg()) {
    const response = await request(t.server).post(`${API}/media`).set('Authorization', `Bearer ${token}`).field('purpose', 'kyc').attach('file', buffer, 'id.jpg');
    return data(response).id as string;
  }

  async function shippedOrder(buyer: TestUser, seller: TestUser, price = 60_000) {
    const product = await createProduct(t, seller.id, { price });
    const order = await paidOrder(t, buyer, String(product._id));
    data(await http.post(`/seller/orders/${order.id}/ship`, { carrier: 'GIG Logistics', trackingNumber: 'GIG-77' }, seller.token));
    return { order, product };
  }

  describe('reviews', () => {
    it('lets the buyer rate a completed order once, and rolls it into the seller and product scores', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t, { firstName: 'Jonny', lastName: 'Drill' });
      const product = await createProduct(t, seller.id, { price: 45_000 });
      const order = await paidOrder(t, buyer, String(product._id));
      failure(await http.post(`/orders/${order.id}/review`, { rating: 5 }, buyer.token), 409, 'ORDER_NOT_COMPLETE');
      await completeOrder(t, buyer, seller, order.id);

      const review = data(
        await http.post(
          `/orders/${order.id}/review`,
          { rating: 4, aspects: { communication: 5, itemAsDescribed: 4, shippingSpeed: 3 }, body: 'Good communication and product as described.' },
          buyer.token,
        ),
      );
      expect(review).toMatchObject({ name: 'Jonny Drill', verified: true, rating: 4, response: null, orderNumber: order.number });
      failure(await http.post(`/orders/${order.id}/review`, { rating: 5 }, buyer.token), 409, 'ALREADY_REVIEWED');
      failure(await http.post(`/orders/${order.id}/review`, { rating: 9 }, buyer.token), 400, 'VALIDATION_FAILED');
      expect(data(await http.get(`/orders/${order.id}`, buyer.token))).toMatchObject({ reviewed: true, actions: [] });

      const ratings = data(await http.get('/seller/reviews', seller.token));
      expect(ratings.summary).toMatchObject({ average: 4, total: 1 });
      expect(ratings.summary.distribution).toEqual([
        { stars: 5, count: 0 },
        { stars: 4, count: 1 },
        { stars: 3, count: 0 },
        { stars: 2, count: 0 },
        { stars: 1, count: 0 },
      ]);
      expect(ratings.summary.aspects.find((aspect: any) => aspect.key === 'communication')).toEqual({ key: 'communication', label: 'Communication', score: 5 });

      const detail = data(await http.get(`/products/${product._id}`));
      expect(detail).toMatchObject({ rating: 4, ratingCount: 1, reviewCount: 1 });
      expect(detail.reviews[0]).toMatchObject({ author: 'Jonny Drill', body: 'Good communication and product as described.' });
      expect(data(await http.get(`/sellers/${seller.id}/reviews`)).summary.total).toBe(1);
    });

    it('lets the seller reply publicly and staff hide abuse', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const product = await createProduct(t, seller.id);
      const order = await paidOrder(t, buyer, String(product._id));
      await completeOrder(t, buyer, seller, order.id);
      const review = data(await http.post(`/orders/${order.id}/review`, { rating: 1, body: 'Terrible!!' }, buyer.token));

      const other = await registerSeller(t);
      failure(await http.post(`/seller/reviews/${review.id}/reply`, { body: 'Not mine' }, other.token), 404, 'REVIEW_NOT_FOUND');
      const replied = data(await http.post(`/seller/reviews/${review.id}/reply`, { body: 'Sorry to hear that — please message us.' }, seller.token));
      expect(replied.response.body).toBe('Sorry to hear that — please message us.');

      const moderator = await staffToken(t, 'moderator');
      data(await http.patch(`/admin/reviews/${review.id}`, { hidden: true }, moderator.token));
      expect(data(await http.get('/seller/reviews', seller.token)).summary).toMatchObject({ average: 0, total: 0 });
      expect((await model<User>(t, User.name).findById(seller.id).lean())!.stats.ratingCount).toBe(0);
    });

    it('highlights real, visible, positive reviews with something to say, one per buyer', async () => {
      const seller = await registerSeller(t);
      const review = async (buyer: TestUser, rating: number, body: string) => {
        const product = await createProduct(t, seller.id, { title: `Item for ${body.slice(0, 10)}` });
        const order = await paidOrder(t, buyer, String(product._id));
        await completeOrder(t, buyer, seller, order.id);
        return data(await http.post(`/orders/${order.id}/review`, { rating, body }, buyer.token));
      };
      const fan = await registerUser(t, { firstName: 'Amaka', lastName: 'Nwosu', location: 'Ikeja' });
      const praise = 'Exactly as described, quick delivery and the escrow made me feel safe.';
      await review(fan, 5, praise);
      await review(fan, 5, 'A second glowing review from the same buyer, long enough to count.');
      await review(await registerUser(t), 2, 'Long enough body but a low rating should never be highlighted here.');
      await review(await registerUser(t), 5, 'Too short');
      const hidden = await review(await registerUser(t), 5, 'This one is lovely but a moderator hid it, so it stays off the landing page.');
      data(await http.patch(`/admin/reviews/${hidden.id}`, { hidden: true }, (await staffToken(t, 'moderator')).token));

      const highlights = data(await http.get('/reviews/highlights?limit=12'));
      const mine = highlights.filter((entry: any) => entry.author === 'Amaka N.');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ rating: 5, location: expect.stringContaining('Ikeja'), title: expect.stringMatching(/^Item for/) });
      expect(highlights.every((entry: any) => entry.rating >= 4 && entry.body.length >= 40)).toBe(true);
      expect(highlights.some((entry: any) => entry.id === hidden.id)).toBe(false);
      expect(highlights[0]).not.toHaveProperty('buyerId');
      failure(await http.get('/reviews/highlights?limit=50'), 400, 'VALIDATION_FAILED');
    });
  });

  describe('identity verification', () => {
    it('submits documents, links the payout bank and waits for review', async () => {
      const admin = await staffToken(t, 'admin');
      const seller = await registerSeller(t, { verifiedIdentity: false });
      const front = await kycUpload(seller.token);
      const selfie = await kycUpload(seller.token);
      const body = {
        idType: 'national-id',
        documents: { idFront: front, selfie },
        livenessPassed: true,
        bank: { method: 'instant', bankCode: '058', accountNumber: '0123456700' },
        consents: [true, true, true],
      };
      failure(await http.post('/me/verification', { ...body, livenessPassed: false }, seller.token), 400, 'LIVENESS_REQUIRED');
      failure(await http.post('/me/verification', { ...body, consents: [true, false, true] }, seller.token), 400, 'CONSENT_REQUIRED');
      failure(await http.post('/me/verification', { ...body, bank: { ...body.bank, method: 'micro' } }, seller.token), 400, 'MICRO_DEPOSITS_UNAVAILABLE');
      const stranger = await registerUser(t);
      failure(await http.post('/me/verification', body, stranger.token), 400, 'MEDIA_NOT_FOUND');

      const submitted = data(await http.post('/me/verification', body, seller.token));
      expect(submitted).toMatchObject({ identity: 'pending', verification: { status: 'pending', idTypeLabel: 'National ID', bank: { bankName: 'Guaranty Trust Bank', last4: '6700' } } });
      failure(await http.post('/me/verification', body, seller.token), 409, 'VERIFICATION_PENDING');
      expect(data(await http.get('/me/verification', seller.token))).toMatchObject({ identity: 'pending', latest: { status: 'pending' } });
      const accounts = data(await http.get('/me/payment-accounts', seller.token));
      expect(accounts.find((account: any) => account.type === 'bank')).toMatchObject({ last4: '6700', primary: true });

      const bell = data(await http.get('/admin/notifications', admin.token));
      expect(bell.rows.some((row: any) => row.type === 'kyc.submitted')).toBe(true);
    });

    it('lets staff with users.verify review documents behind signed links and approve', async () => {
      const seller = await registerSeller(t, { verifiedIdentity: false });
      const product = await createProduct(t, seller.id, { sellerVerified: false });
      const front = await kycUpload(seller.token);
      const selfie = await kycUpload(seller.token);
      data(await http.post('/me/verification', { idType: 'passport', documents: { idFront: front, selfie }, livenessPassed: true, consents: [true, true, true] }, seller.token));

      const moderator = await staffToken(t, 'moderator');
      const pending = data(await http.get('/admin/verifications?status=pending', moderator.token));
      const row = pending.rows.find((entry: any) => entry.userId === seller.id);
      const detail = data(await http.get(`/admin/verifications/${row.id}`, moderator.token));
      expect(detail.documents.map((doc: any) => doc.label)).toEqual(['ID Document (Passport)', 'Selfie Verification']);
      const link = new URL(detail.documents[0].asset);
      expect((await request(t.server).get(`${link.pathname}${link.search}`)).status).toBe(200);
      failure(await http.post(`/admin/verifications/${row.id}/approve`, {}, moderator.token), 403, 'PERMISSION_DENIED');

      const admin = await staffToken(t, 'admin');
      const approved = data(await http.post(`/admin/verifications/${row.id}/approve`, { level: 'high-value' }, admin.token));
      expect(approved.status).toBe('approved');
      expect(data(await http.get('/auth/me', seller.token))).toMatchObject({ identity: 'verified', verificationLevel: 'high-value' });
      expect((await model<Product>(t, Product.name).findById(product._id).lean())!.sellerVerified).toBe(true);
      failure(await http.post(`/admin/verifications/${row.id}/reject`, { reason: 'Too late now' }, admin.token), 409, 'VERIFICATION_NOT_PENDING');
    });

    it('rejects with a reason the user can act on, then accepts a new submission', async () => {
      const buyer = await registerUser(t);
      const front = await kycUpload(buyer.token);
      const selfie = await kycUpload(buyer.token);
      const body = { idType: 'drivers-license', documents: { idFront: front, selfie }, livenessPassed: true, consents: [true, true, true] };
      data(await http.post('/me/verification', body, buyer.token));
      const admin = await staffToken(t, 'admin');
      const row = data(await http.get('/admin/verifications?status=pending', admin.token)).rows.find((entry: any) => entry.userId === buyer.id);
      data(await http.post(`/admin/verifications/${row.id}/reject`, { reason: 'The photo is blurry. Retake it in good light.' }, admin.token));
      expect(data(await http.get('/me/verification', buyer.token))).toMatchObject({ identity: 'rejected', latest: { rejectionReason: 'The photo is blurry. Retake it in good light.' } });
      const retry = { ...body, documents: { idFront: await kycUpload(buyer.token), selfie: await kycUpload(buyer.token) } };
      expect(data(await http.post('/me/verification', retry, buyer.token)).identity).toBe('pending');
    });
  });

  describe('disputes', () => {
    it('freezes payment when the buyer reports a problem, and tells everyone', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t, { firstName: 'Melissa', lastName: 'Jones' });
      const unshippedProduct = await createProduct(t, seller.id);
      const unshipped = await paidOrder(t, buyer, String(unshippedProduct._id));
      failure(await http.post(`/orders/${unshipped.id}/dispute`, { reason: 'Seller is not responding to me at all.' }, buyer.token), 409, 'ORDER_NOT_DISPUTABLE');

      const { order } = await shippedOrder(buyer, seller);
      const photo = await uploadImage(t, buyer.token, 'evidence');
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'Item arrived with a large crack down the side.', evidence: [photo] }, buyer.token));
      expect(dispute).toMatchObject({ state: 'active', outcome: null, evidence: [photo], orderNumber: order.number });
      expect(dispute.reference).toMatch(/^#\d{4,}$/);
      failure(await http.post(`/orders/${order.id}/dispute`, { reason: 'Again with feeling please.' }, buyer.token), 409, 'DISPUTE_EXISTS');

      const view = data(await http.get(`/orders/${order.id}`, buyer.token));
      expect(view).toMatchObject({ escrow: { phase: 'disputed' }, disputeId: dispute.id, actions: [] });
      const thread = data(await http.get(`/conversations/${dispute.conversationId}`, seller.token));
      expect(thread.escrow.status).toBe('Item Disputed');
      expect(thread.messages.slice(-2).map((message: any) => message.kind)).toEqual(['image', 'dispute']);
      await settle(t);
      expect(data(await http.get('/notifications', seller.token)).rows.some((row: any) => row.type === 'dispute.opened')).toBe(true);
    });

    it('takes the seller’s side, lets support moderate in the thread, and refunds on a ruling', async () => {
      const seller = await registerSeller(t, { storeName: 'Ken Brown Ceramics' });
      const buyer = await registerUser(t, { firstName: 'Melissa', lastName: 'Jones' });
      const { order } = await shippedOrder(buyer, seller, 273_990);
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'Handmade ceramics arrived broken in two places.' }, buyer.token));

      failure(await http.post(`/disputes/${dispute.id}/respond`, { claim: 'I am the buyer, not the seller here.' }, buyer.token), 403, 'NOT_SELLER');
      const responded = data(await http.post(`/disputes/${dispute.id}/respond`, { claim: 'The set was packed in double-walled cartons.' }, seller.token));
      expect(responded.sellerClaim).toBe('The set was packed in double-walled cartons.');

      const moderator = await staffToken(t, 'moderator');
      const list = data(await http.get('/admin/disputes?search=ceramics&states=active', moderator.token));
      expect(list.map((row: any) => row.id)).toContain(dispute.id);
      const detail = data(await http.get(`/admin/disputes/${dispute.id}`, moderator.token));
      expect(detail).toMatchObject({ buyerShortName: 'M.Jones', sellerName: 'Ken Brown Ceramics', orderValue: order.total, sellerClaim: 'The set was packed in double-walled cartons.' });
      expect(detail.thread.some((entry: any) => entry.kind === 'event' && entry.body === 'Dispute opened by Buyer')).toBe(true);
      expect(detail.thread.at(-1)).toMatchObject({ kind: 'message', party: 'seller' });

      const entry = data(await http.post(`/admin/disputes/${dispute.id}/messages`, { body: 'Hi both, I am reviewing the dispute details.' }, moderator.token));
      expect(entry).toMatchObject({ kind: 'message', party: 'admin', body: 'Hi both, I am reviewing the dispute details.' });
      expect(data(await http.get(`/conversations/${dispute.conversationId}`, buyer.token)).messages.at(-1)).toMatchObject({ kind: 'admin', senderRole: 'staff' });

      // Support can attach a photo or a document; both sides see it and the console draws it.
      const staffUpload = async (buffer: Buffer, name: string, purpose = 'evidence') =>
        data(await request(t.server).post(`${API}/admin/media`).set('Authorization', `Bearer ${moderator.token}`).field('purpose', purpose).attach('file', buffer, name)).url as string;
      const photo = await staffUpload(FILES.png(), 'crack.png');
      const policy = await staffUpload(FILES.pdf(), 'packaging-policy.pdf', 'message');
      expect(data(await http.post(`/admin/disputes/${dispute.id}/messages`, { body: 'This is the crack I mean.', image: photo }, moderator.token))).toMatchObject({ image: photo });
      expect(data(await http.post(`/admin/disputes/${dispute.id}/messages`, { body: 'Our packaging policy.', image: policy }, moderator.token))).toMatchObject({ image: policy, fileName: 'packaging-policy.pdf' });
      const seen = data(await http.get(`/conversations/${dispute.conversationId}`, buyer.token)).messages.slice(-2);
      expect(seen[0]).toMatchObject({ kind: 'admin', media: { url: photo, format: 'PNG' } });
      expect(seen[1]).toMatchObject({ kind: 'admin', media: { url: policy, name: 'packaging-policy.pdf', format: 'PDF' } });
      const drawn = data(await http.get(`/admin/disputes/${dispute.id}`, moderator.token)).thread.filter((row: any) => row.kind === 'attachment' && row.party === 'admin');
      expect(drawn.map((row: any) => [row.image, row.fileName ?? null])).toEqual([
        [photo, null],
        [policy, 'packaging-policy.pdf'],
      ]);
      const stranger = await staffUpload(FILES.png(), 'other.png');
      await model<User>(t, User.name).db.collection('media').updateOne({ url: stranger }, { $set: { purpose: 'product' } });
      failure(await http.post(`/admin/disputes/${dispute.id}/messages`, { body: 'Wrong kind of upload.', image: stranger }, moderator.token), 400, 'MEDIA_NOT_FOUND');

      const asked = data(await http.post(`/admin/disputes/${dispute.id}/resolve`, { outcome: 'evidence-requested' }, moderator.token));
      expect(asked).toMatchObject({ outcome: 'evidence-requested', state: 'pending' });

      const refunded = data(await http.post(`/admin/disputes/${dispute.id}/resolve`, { outcome: 'refunded', note: 'Photos confirm the damage.' }, moderator.token));
      expect(refunded).toMatchObject({ outcome: 'refunded', state: 'completed' });
      await settle(t);
      expect(data(await http.get(`/orders/${order.id}`, buyer.token))).toMatchObject({ status: 'cancelled', escrow: { phase: 'refunded' }, refunded: true });
      failure(await http.post(`/admin/disputes/${dispute.id}/resolve`, { outcome: 'released' }, moderator.token), 409, 'DISPUTE_CLOSED');
      const log = data(await http.get('/admin/audit?targetType=dispute', moderator.token));
      expect(log.rows[0].action).toBe('Ruled on a dispute — refunded to buyer');
    });

    it('releases to the seller on a ruling, or closes and resumes the order', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const admin = await staffToken(t, 'admin');

      const first = await shippedOrder(buyer, seller, 40_000);
      const releasedDispute = data(await http.post(`/orders/${first.order.id}/dispute`, { reason: 'Not sure this is the right colour.' }, buyer.token));
      data(await http.post(`/admin/disputes/${releasedDispute.id}/resolve`, { outcome: 'released' }, admin.token));
      await settle(t);
      expect(data(await http.get('/seller/earnings', seller.token)).overview.available).toBe(45_000);

      const second = await shippedOrder(buyer, seller, 30_000);
      data(await http.post(`/orders/${second.order.id}/received`, {}, buyer.token));
      const closedDispute = data(await http.post(`/orders/${second.order.id}/dispute`, { reason: 'Changed my mind about the colour.' }, buyer.token));
      data(await http.post(`/admin/disputes/${closedDispute.id}/resolve`, { outcome: 'closed', note: 'Not a valid reason.' }, admin.token));
      const resumed = data(await http.get(`/orders/${second.order.id}`, buyer.token));
      expect(resumed.escrow.phase).toBe('inspection');
      expect(resumed.escrow.inspectionSeconds).toBeGreaterThan(6 * 86_400);
    });

    it('reopens a dispute closed without action, putting the payment back on hold', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const admin = await staffToken(t, 'admin');
      const moderator = await staffToken(t, 'moderator');
      const { order } = await shippedOrder(buyer, seller, 25_000);
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'The charger in the box does not work.' }, buyer.token));

      failure(await http.post(`/admin/disputes/${dispute.id}/reopen`, {}, admin.token), 409, 'DISPUTE_OPEN');
      data(await http.post(`/admin/disputes/${dispute.id}/resolve`, { outcome: 'closed' }, admin.token));
      expect(data(await http.get(`/orders/${order.id}`, buyer.token)).escrow.phase).toBe('shipped');

      const reopened = data(await http.post(`/admin/disputes/${dispute.id}/reopen`, { note: 'The buyer sent a video of the fault.' }, moderator.token));
      expect(reopened).toMatchObject({ id: dispute.id, state: 'active', dispute: { state: 'active', outcome: null, resolutionNote: null } });
      expect(reopened.dispute.thread.at(-1)).toMatchObject({ party: 'admin' });
      expect(reopened.dispute.thread.at(-1).body).toContain('reopened dispute');
      expect(data(await http.get(`/orders/${order.id}`, buyer.token)).escrow.phase).toBe('disputed');
      expect(data(await http.get(`/disputes/${dispute.id}`, buyer.token))).toMatchObject({ state: 'active', outcome: null });

      // Ruled again — this time with money moving — it can no longer come back.
      data(await http.post(`/admin/disputes/${dispute.id}/resolve`, { outcome: 'refunded' }, admin.token));
      failure(await http.post(`/admin/disputes/${dispute.id}/reopen`, {}, admin.token), 409, 'DISPUTE_SETTLED');
      const log = data(await http.get('/admin/audit?targetType=dispute', admin.token));
      expect(log.rows.map((row: any) => row.action)).toContain('Reopened a dispute');
      await settle(t);
      expect(data(await http.get('/notifications', seller.token)).rows.some((row: any) => row.type === 'dispute.reopened')).toBe(true);
    });

    it('refuses to reopen once the reopen window has passed or the order has moved on', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const admin = await staffToken(t, 'admin');
      const { order } = await shippedOrder(buyer, seller, 22_000);
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'Wrong size was delivered to me.' }, buyer.token));
      data(await http.post(`/admin/disputes/${dispute.id}/resolve`, { outcome: 'closed' }, admin.token));

      const disputes = model<any>(t, 'Dispute');
      await disputes.updateOne({ _id: dispute.id }, { $set: { resolvedAt: new Date(Date.now() - 8 * 86_400_000) } });
      failure(await http.post(`/admin/disputes/${dispute.id}/reopen`, {}, admin.token), 409, 'REOPEN_WINDOW_PASSED');

      await disputes.updateOne({ _id: dispute.id }, { $set: { resolvedAt: new Date() } });
      data(await http.post(`/orders/${order.id}/received`, {}, buyer.token));
      data(await http.post(`/orders/${order.id}/release/code`, {}, buyer.token));
      const code = await codeFromMail(t, buyer.email);
      data(await http.post(`/orders/${order.id}/release`, { code }, buyer.token));
      failure(await http.post(`/admin/disputes/${dispute.id}/reopen`, {}, admin.token), 409, 'ORDER_MOVED_ON');
      // The failed attempt left the dispute as it was.
      expect(data(await http.get(`/admin/disputes/${dispute.id}`, admin.token))).toMatchObject({ state: 'completed', outcome: 'closed' });
    });

    it('closes the dispute when a superadmin force-releases from the ledger', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const { order } = await shippedOrder(buyer, seller);
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'Parcel never arrived at my address.' }, buyer.token));
      const superadmin = await staffToken(t, 'superadmin');
      data(await http.post(`/admin/escrows/${order.orderId}/settle`, { settlement: 'force-released' }, superadmin.token));
      await settle(t);
      expect(data(await http.get(`/disputes/${dispute.id}`, buyer.token))).toMatchObject({ state: 'completed', outcome: 'released' });
    });

    it('keeps disputes private to their parties', async () => {
      const seller = await registerSeller(t);
      const buyer = await registerUser(t);
      const { order } = await shippedOrder(buyer, seller);
      const dispute = data(await http.post(`/orders/${order.id}/dispute`, { reason: 'Wrong model was delivered to me.' }, buyer.token));
      const stranger = await registerUser(t);
      failure(await http.get(`/disputes/${dispute.id}`, stranger.token), 404, 'DISPUTE_NOT_FOUND');
      expect(data(await http.get('/disputes', buyer.token)).map((row: any) => row.id)).toContain(dispute.id);
    });
  });
});
