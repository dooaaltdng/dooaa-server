import { io, type Socket } from 'socket.io-client';
import { createTestApp, type TestApp } from './utils/app';
import { Http, data, failure } from './utils/http';
import { eventually } from './utils/eventually';
import { createProduct, model, registerSeller, registerUser, staffToken, uploadImage, type TestUser } from './utils/factories';
import { DELIVERY, payAndVerify, settle } from './utils/commerce';
import { Product } from '../src/modules/products/schemas/product.schema';

describe('Messaging, offers, meetups and realtime (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let seller: TestUser;
  let buyer: TestUser;
  const sockets: Socket[] = [];

  const connect = (token?: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`${t.url}/realtime`, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true, reconnection: false });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (error) => reject(error));
    });

  const next = <T = any>(socket: Socket, event: string, timeoutMs = 3000) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const ack = <T = any>(socket: Socket, event: string, payload: unknown) =>
    new Promise<T>((resolve) => socket.emit(event, payload, (response: T) => resolve(response)));

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
    http = new Http(t);
    seller = await registerSeller(t, { storeName: 'Nelson Stores' });
    buyer = await registerUser(t, { firstName: 'Ada', lastName: 'Obi' });
  });
  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await t.close();
  });

  describe('threads', () => {
    it('starts a thread about a listing, with the enquiry quoting it', async () => {
      const product = await createProduct(t, seller.id, { title: 'Samsung Galaxy S23 Ultra', price: 4_200_000, pricing: 'negotiable' });
      const thread = data(await http.post('/conversations', { productId: String(product._id), body: 'Hello, is this item still available?' }, buyer.token));
      expect(thread).toMatchObject({
        viewerRole: 'buyer',
        name: 'Sola Seller',
        store: 'Nelson Stores',
        verified: true,
        productId: String(product._id),
        subject: { title: 'Samsung Galaxy S23 Ultra', price: 4_200_000 },
        unread: 0,
        escrow: null,
      });
      expect(thread.messages[0]).toMatchObject({ mine: true, kind: 'product', body: 'Hello, is this item still available?', product: { title: 'Samsung Galaxy S23 Ultra', price: 4_200_000 } });
      expect(thread.messages[0].time).toMatch(/^\d{2}:\d{2}(am|pm)$/);

      const inbox = data(await http.get('/conversations', seller.token));
      expect(inbox.rows[0]).toMatchObject({ id: thread.id, viewerRole: 'seller', name: 'Ada Obi', store: 'Buyer', unread: 1, preview: 'Hello, is this item still available?' });
      expect(data(await http.get('/conversations/unread-count', seller.token))).toEqual({ threads: 1, messages: 1 });
      expect((await model<Product>(t, Product.name).findById(product._id).lean())!.stats.inquiries).toBe(1);

      // Asking again reuses the same thread.
      const again = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      expect(again.id).toBe(thread.id);
    });

    it('refuses to message yourself or without a verified email', async () => {
      const product = await createProduct(t, seller.id);
      failure(await http.post('/conversations', { productId: String(product._id) }, seller.token), 403, 'OWN_LISTING');
      const unverified = await registerUser(t, { verifyEmail: false });
      failure(await http.post('/conversations', { productId: String(product._id) }, unverified.token), 403, 'EMAIL_NOT_VERIFIED');
      failure(await http.post('/conversations', {}, buyer.token), 400, 'VALIDATION_FAILED');
    });

    it('sends text and uploaded attachments, and tracks unread on the other side', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      failure(await http.post(`/conversations/${thread.id}/messages`, { body: '   ' }, buyer.token), 400, 'VALIDATION_FAILED');
      data(await http.post(`/conversations/${thread.id}/messages`, { body: 'Can you share a video?' }, buyer.token));

      const photo = await uploadImage(t, seller.token, 'message');
      const sent = data(await http.post(`/conversations/${thread.id}/messages`, { kind: 'image', mediaUrl: photo }, seller.token));
      expect(sent).toMatchObject({ mine: true, kind: 'image', media: { url: photo, format: 'JPEG' } });
      failure(await http.post(`/conversations/${thread.id}/messages`, { kind: 'video', mediaUrl: photo }, seller.token), 400, 'VALIDATION_FAILED');
      failure(await http.post(`/conversations/${thread.id}/messages`, { kind: 'image', mediaUrl: 'https://evil.example.com/x.jpg' }, seller.token), 400, 'MEDIA_NOT_FOUND');

      const buyerView = data(await http.get(`/conversations/${thread.id}`, buyer.token));
      expect(buyerView.unread).toBe(1);
      expect(buyerView.preview).toBe('Sent a photo');
      data(await http.post(`/conversations/${thread.id}/read`, {}, buyer.token));
      expect(data(await http.get(`/conversations/${thread.id}`, buyer.token)).unread).toBe(0);
    });

    it('keeps strangers out', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const stranger = await registerUser(t);
      failure(await http.get(`/conversations/${thread.id}`, stranger.token), 404, 'CONVERSATION_NOT_FOUND');
      failure(await http.post(`/conversations/${thread.id}/messages`, { body: 'hi' }, stranger.token), 404, 'CONVERSATION_NOT_FOUND');
    });

    it('pages back through history', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      for (let index = 0; index < 7; index += 1) data(await http.post(`/conversations/${thread.id}/messages`, { body: `message ${index}` }, buyer.token));
      const latest = data(await http.get(`/conversations/${thread.id}/messages?limit=3`, buyer.token));
      expect(latest.messages.map((message: any) => message.body)).toEqual(['message 4', 'message 5', 'message 6']);
      expect(latest.hasMore).toBe(true);
      const older = data(await http.get(`/conversations/${thread.id}/messages?limit=3&before=${latest.messages[0].id}`, buyer.token));
      expect(older.messages.map((message: any) => message.body)).toEqual(['message 1', 'message 2', 'message 3']);
    });

    it('filters the inbox to unread and searches it', async () => {
      const other = await registerSeller(t, { storeName: 'Gadget Hub' });
      const product = await createProduct(t, other.id, { title: 'Nexus Twin Tub Washing Machine' });
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      data(await http.post(`/conversations/${thread.id}/messages`, { body: 'Sent you the receipt' }, other.token));
      const unread = data(await http.get('/conversations?filter=unread', buyer.token));
      expect(unread.rows.map((row: any) => row.id)).toContain(thread.id);
      expect(data(await http.get('/conversations?q=washing', buyer.token)).rows.map((row: any) => row.id)).toEqual([thread.id]);
      expect(data(await http.get('/conversations?q=Gadget%20Hub', buyer.token)).rows.map((row: any) => row.id)).toEqual([thread.id]);
    });
  });

  describe('offers', () => {
    it('refuses offers on fixed-price listings', async () => {
      const product = await createProduct(t, seller.id, { pricing: 'fixed' });
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      failure(await http.post(`/conversations/${thread.id}/offers`, { amount: 300_000 }, buyer.token), 409, 'FIXED_PRICE');
    });

    it('runs offer → counter → accept, and escrow checkout charges the agreed price', async () => {
      const product = await createProduct(t, seller.id, { title: 'Samsung Galaxy S23', price: 4_200_000, pricing: 'negotiable' });
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const afterOffer = data(await http.post(`/conversations/${thread.id}/offers`, { amount: 3_800_000, note: 'Would you consider this?' }, buyer.token));
      expect(afterOffer.offer).toMatchObject({ amount: 3_800_000, listed: 4_200_000, status: 'pending', note: 'Would you consider this?', from: { role: 'Buyer' } });
      expect(afterOffer.messages.at(-1)).toMatchObject({ kind: 'product', product: { price: 3_800_000 } });

      const offerId = afterOffer.offer.id;
      failure(await http.post(`/offers/${offerId}/accept`, {}, buyer.token), 409, 'OFFER_NOT_PENDING');
      failure(await http.post(`/offers/${offerId}/counter`, { amount: 4_000_000 }, buyer.token), 409, 'OFFER_NOT_PENDING');

      const countered = data(await http.post(`/offers/${offerId}/counter`, { amount: 4_000_000, note: 'Meet me halfway' }, seller.token));
      expect(countered.offer).toMatchObject({ status: 'countered', counter: { amount: 4_000_000, note: 'Meet me halfway' } });
      expect(countered.messages.at(-1)).toMatchObject({ kind: 'system', systemLead: 'Counter offer sent.' });

      const accepted = data(await http.post(`/offers/${offerId}/accept`, {}, buyer.token));
      expect(accepted.offer).toMatchObject({ status: 'accepted', agreedAmount: 4_000_000 });

      const quote = data(await http.get(`/checkout/escrow/${product._id}/quote?offerId=${offerId}`, buyer.token));
      expect(quote.quote).toMatchObject({ itemPrice: 4_000_000, escrowFee: 20_000, total: 4_025_000 });
    });

    it('lets the seller decline and the buyer withdraw', async () => {
      const product = await createProduct(t, seller.id, { pricing: 'negotiable' });
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const first = data(await http.post(`/conversations/${thread.id}/offers`, { amount: 100_000 }, buyer.token)).offer;
      expect(data(await http.post(`/offers/${first.id}/decline`, {}, seller.token)).messages.at(-1)).toMatchObject({ systemLead: 'Offer declined.' });
      const second = data(await http.post(`/conversations/${thread.id}/offers`, { amount: 150_000 }, buyer.token)).offer;
      data(await http.post(`/offers/${second.id}/withdraw`, {}, buyer.token));
      failure(await http.post(`/offers/${second.id}/accept`, {}, seller.token), 409, 'OFFER_NOT_PENDING');
    });

    it('notifies the seller of a new offer', async () => {
      const product = await createProduct(t, seller.id, { pricing: 'negotiable', title: 'Notify Me Phone' });
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      data(await http.post(`/conversations/${thread.id}/offers`, { amount: 120_000 }, buyer.token));
      await eventually(async () => {
        const bell = data(await http.get('/notifications', seller.token));
        expect(bell.rows.some((row: any) => row.type === 'offer.made' && row.body.includes('Notify Me Phone'))).toBe(true);
      });
    });
  });

  describe('meetups', () => {
    const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    it('proposes a meetup the other side can accept once', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      failure(await http.post(`/conversations/${thread.id}/meetups`, { place: 'Central Park Cafe', date: tomorrow(), from: '16:00', to: '14:00' }, seller.token), 400, 'VALIDATION_FAILED');
      failure(await http.post(`/conversations/${thread.id}/meetups`, { place: 'Central Park Cafe', date: '2020-01-01', from: '14:00', to: '16:00' }, seller.token), 400, 'VALIDATION_FAILED');
      const meetup = data(await http.post(`/conversations/${thread.id}/meetups`, { place: 'Central Park Cafe, 123 Park Avenue, Lagos', date: tomorrow(), from: '14:00', to: '16:00' }, seller.token));
      expect(meetup).toMatchObject({ kind: 'meetup', meetup: { venue: 'Central Park Cafe, 123 Park Avenue, Lagos', window: '2:00 PM - 4:00 PM', status: 'proposed' } });

      failure(await http.post(`/conversations/${thread.id}/meetups/${meetup.id}/accept`, {}, seller.token), 403, 'OWN_PROPOSAL');
      const accepted = data(await http.post(`/conversations/${thread.id}/meetups/${meetup.id}/accept`, {}, buyer.token));
      expect(accepted.meetup.status).toBe('accepted');
      failure(await http.post(`/conversations/${thread.id}/meetups/${meetup.id}/decline`, {}, buyer.token), 409, 'MEETUP_ANSWERED');
      const detail = data(await http.get(`/conversations/${thread.id}`, buyer.token));
      expect(detail.messages.at(-1)).toMatchObject({ kind: 'system', systemLead: 'Meetup confirmed.' });
    });
  });

  describe('orders in the thread', () => {
    it('links the paid order to the enquiry thread and narrates it', async () => {
      const product = await createProduct(t, seller.id, { title: 'Twin Tub Washing Machine', price: 549_000 });
      const thread = data(await http.post('/conversations', { productId: String(product._id), body: 'Is the warranty still valid?' }, buyer.token));
      const checkout = data(await http.post('/checkout/escrow', { productId: String(product._id), method: 'card', delivery: DELIVERY }, buyer.token));
      await payAndVerify(t, buyer, checkout.payment.reference);

      let detail = data(await http.get(`/conversations/${thread.id}`, buyer.token));
      expect(detail.escrow).toMatchObject({
        orderId: checkout.orders[0].id,
        phase: 'funded',
        status: 'Funded',
        productPrice: 549_000,
        fee: 2_745,
        shipping: 5_000,
        buyer: { mask: '**** 4081' },
        seller: { name: 'Nelson Stores' },
      });
      expect(detail.escrow.trackingSteps).toHaveLength(5);
      expect(detail.escrow.shipWithinSeconds).toBeGreaterThan(0);
      expect(detail.messages.at(-1)).toMatchObject({ kind: 'system', systemLead: 'Escrow funded.' });

      data(await http.post(`/seller/orders/${checkout.orders[0].id}/ship`, { carrier: 'Red Star Express', trackingNumber: 'RS-2211' }, seller.token));
      await settle(t);
      detail = data(await http.get(`/conversations/${thread.id}`, buyer.token));
      expect(detail.escrow).toMatchObject({ phase: 'shipped', status: 'Item Is Shipped' });
      expect(detail.escrow.trackingSteps.slice(0, 2).every((step: any) => step.done)).toBe(true);
      expect(detail.messages.at(-1)).toMatchObject({ systemLead: 'Item marked as shipped.', body: 'Red Star Express · Tracking RS-2211' });
      expect(data(await http.get(`/orders/${checkout.orders[0].id}`, buyer.token)).conversationId).toBe(thread.id);
    });
  });

  describe('realtime', () => {
    it('refuses sockets without a valid token', async () => {
      await expect(connect()).rejects.toThrow(/Sign in/);
      await expect(connect('not-a-token')).rejects.toThrow();
    });

    it('delivers new messages live to the other participant', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const sellerSocket = await connect(seller.token);
      const incoming = next(sellerSocket, 'message:new');
      const updated = next(sellerSocket, 'conversation:updated');
      data(await http.post(`/conversations/${thread.id}/messages`, { body: 'Live hello' }, buyer.token));
      expect(await incoming).toMatchObject({ conversationId: thread.id, message: { body: 'Live hello', mine: false } });
      expect(await updated).toMatchObject({ id: thread.id, unread: 1, preview: 'Live hello' });
    });

    it('sends over the socket with an acknowledgement, and relays typing', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const buyerSocket = await connect(buyer.token);
      const sellerSocket = await connect(seller.token);
      expect(await ack(buyerSocket, 'conversation:join', { conversationId: thread.id })).toEqual({ ok: true, data: { joined: thread.id } });
      expect((await ack(sellerSocket, 'conversation:join', { conversationId: thread.id })).ok).toBe(true);

      const typing = next(sellerSocket, 'typing');
      await ack(buyerSocket, 'typing', { conversationId: thread.id, typing: true });
      expect(await typing).toMatchObject({ conversationId: thread.id, userId: buyer.id, typing: true });

      const reply = await ack<any>(buyerSocket, 'message:send', { conversationId: thread.id, body: 'Sent over the socket' });
      expect(reply).toMatchObject({ ok: true, data: { body: 'Sent over the socket', mine: true } });
      const empty = await ack<any>(buyerSocket, 'message:send', { conversationId: thread.id, body: '' });
      expect(empty).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    });

    it('does not let strangers join or post into a thread', async () => {
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const stranger = await registerUser(t);
      const socket = await connect(stranger.token);
      expect(await ack(socket, 'conversation:join', { conversationId: thread.id })).toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
      expect(await ack(socket, 'message:send', { conversationId: thread.id, body: 'hi' })).toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' });
      expect(await ack(socket, 'typing', { conversationId: thread.id, typing: true })).toMatchObject({ ok: false, code: 'NOT_JOINED' });
    });

    it('pushes notifications live and reports presence', async () => {
      const buyerSocket = await connect(buyer.token);
      const product = await createProduct(t, seller.id, { pricing: 'negotiable', title: 'Live Offer Phone' });
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, buyer.token));
      const offer = data(await http.post(`/conversations/${thread.id}/offers`, { amount: 90_000 }, buyer.token)).offer;
      const pushed = next<any>(buyerSocket, 'notification:new');
      data(await http.post(`/offers/${offer.id}/decline`, {}, seller.token));
      expect(await pushed).toMatchObject({ type: 'offer.declined', title: 'Offer declined' });
      const presence = await ack<any>(buyerSocket, 'presence:query', { ids: [buyer.id, '000000000000000000000000'] });
      expect(presence).toEqual({ ok: true, data: { [buyer.id]: true, '000000000000000000000000': false } });
    });

    it('lets staff connect and see who is online', async () => {
      const staff = await staffToken(t, 'moderator');
      const staffSocket = await connect(staff.token);
      const online = next<any>(staffSocket, 'presence');
      const someone = await registerUser(t);
      await connect(someone.token);
      expect(await online).toMatchObject({ id: someone.id, online: true });
      const team = data(await http.get('/admin/staff', staff.token));
      expect(team.find((member: any) => member.id === staff.id).online).toBe(true);
    });
  });

  describe('notifications', () => {
    it('lists, counts and clears the bell', async () => {
      const reader = await registerUser(t);
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, reader.token));
      data(await http.post(`/conversations/${thread.id}/messages`, { body: 'One' }, seller.token));
      data(await http.post(`/conversations/${thread.id}/messages`, { body: 'Two' }, seller.token));
      const bell = await eventually(async () => {
        const page = data(await http.get('/notifications', reader.token));
        expect(page.unread).toBe(2);
        return page;
      });
      expect(bell.rows[0]).toMatchObject({ type: 'message.new', title: 'New message from Sola', read: false });
      data(await http.post(`/notifications/${bell.rows[0].id}/read`, {}, reader.token));
      expect(data(await http.get('/notifications/unread-count', reader.token))).toEqual({ unread: 1 });
      expect(data(await http.post('/notifications/read-all', {}, reader.token))).toEqual({ updated: 1 });
      expect(data(await http.get('/notifications?unread=true', reader.token)).total).toBe(0);
    });

    it('turns message alerts off when the user asks', async () => {
      const quiet = await registerUser(t);
      data(await http.patch('/me/notification-preferences', { web: false, email: false }, quiet.token));
      const product = await createProduct(t, seller.id);
      const thread = data(await http.post('/conversations', { productId: String(product._id) }, quiet.token));
      const before = t.mail.outbox.length;
      data(await http.post(`/conversations/${thread.id}/messages`, { body: 'Hello quiet' }, seller.token));
      await settle(t);
      expect(t.mail.outbox.slice(before).some((mail) => mail.to === quiet.email)).toBe(false);
      // The bell still records it (written just after the message is answered).
      await eventually(async () => expect(data(await http.get('/notifications', quiet.token)).total).toBeGreaterThan(0));
    });

    it('alerts the console when a listing is flagged suspicious', async () => {
      const admin = await staffToken(t, 'admin');
      for (let index = 0; index < 5; index += 1) await createProduct(t, seller.id, { categoryId: 'sports', price: 20_000 });
      const image = await uploadImage(t, seller.token);
      data(
        await http.post(
          '/seller/products',
          { title: 'Treadmill X', description: 'A heavy-duty treadmill for home gyms.', price: 2_000_000, pricing: 'fixed', condition: 'new', stock: 1, categoryId: 'sports', delivery: 'local', paymentMethod: 'escrow', images: [image], publish: true },
          seller.token,
        ),
      );
      await eventually(async () => {
        const bell = data(await http.get('/admin/notifications', admin.token));
        expect(bell.rows.some((row: any) => row.type === 'listing.flagged' && row.body.includes('Treadmill X'))).toBe(true);
      });
    });
  });
});
