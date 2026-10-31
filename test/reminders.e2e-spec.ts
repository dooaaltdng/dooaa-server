import { conversations } from '../src/database/schema';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { createTestApp, type TestApp } from './utils/app';
import { createProduct, registerSeller, registerUser, type TestUser } from './utils/factories';
import { Http, data } from './utils/http';

describe('Unread message reminders (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let seller: TestUser;
  let buyer: TestUser;
  let jobs: JobsService;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    jobs = t.app.get(JobsService);
    seller = await registerSeller(t, { storeName: 'Nelson Stores' });
    buyer = await registerUser(t, { firstName: 'Ada', lastName: 'Obi' });
  });
  afterAll(() => t.close());

  it('emails the other side once when a message waits 10 minutes, and never the sender', async () => {
    const product = await createProduct(t, seller.id, { title: 'Yamaha Keyboard' });
    const thread = data(await http.post('/conversations', { productId: product.id, body: 'Is this still available?' }, buyer.token));
    const sentAt = (await t.db.findOne(conversations, { id: thread.id }))!.lastMessageAt!;

    // Not yet 10 minutes: nothing goes out.
    expect(await jobs.remindersJob(new Date(sentAt.getTime() + 5 * 60_000))).toEqual({ sent: 0 });

    const later = new Date(sentAt.getTime() + 11 * 60_000);
    expect(await jobs.remindersJob(later)).toEqual({ sent: 1 });
    await t.mail.idle();
    const mail = t.mail.lastTo(seller.email)!;
    expect(mail.subject).toBe('Ada is waiting for your reply');
    expect(mail.text).toContain('Yamaha Keyboard');
    expect(mail.text).toContain('Is this still available?');
    expect(mail.html).not.toMatch(/escrow/i);
    expect(t.mail.lastTo(buyer.email)?.subject ?? '').not.toContain('waiting for your reply');

    // Same unread message: no second email.
    expect(await jobs.remindersJob(new Date(later.getTime() + 60_000))).toEqual({ sent: 0 });
  });

  it('stays quiet once the message has been read', async () => {
    const product = await createProduct(t, seller.id, { title: 'Gas Cooker' });
    const thread = data(await http.post('/conversations', { productId: product.id, body: 'Hello' }, buyer.token));
    await t.db.update(conversations, { id: thread.id }, { $set: { sellerUnread: 0 } });
    const sentAt = (await t.db.findOne(conversations, { id: thread.id }))!.lastMessageAt!;
    expect(await jobs.remindersJob(new Date(sentAt.getTime() + 11 * 60_000))).toEqual({ sent: 0 });
  });
});
