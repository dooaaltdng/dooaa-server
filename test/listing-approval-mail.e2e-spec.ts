import { products } from '../src/database/schema';
import { JobsService } from '../src/modules/jobs/jobs.service';
import { createTestApp, type TestApp } from './utils/app';
import { createProduct, registerSeller, staffToken, type TestUser } from './utils/factories';
import { Http, data } from './utils/http';

/** The listener runs after the response; wait for its mail to land. */
async function mailTo(t: TestApp, to: string, match: (subject: string) => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await t.mail.idle();
    const hit = [...t.mail.sent].reverse().find((mail) => mail.to === to && match(mail.subject));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

const ALERTS = 'dooaaltd@gmail.com';
const HOUR = 60 * 60_000;

describe('Listing approval emails (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let seller: TestUser;
  let jobs: JobsService;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    jobs = t.app.get(JobsService);
    seller = await registerSeller(t, { storeName: 'Kemi Gadgets' });
  });
  afterAll(() => t.close());

  it('emails the seller when staff approve their listing', async () => {
    const admin = await staffToken(t, 'admin');
    const listing = await createProduct(t, seller.id, { title: 'iPhone 14 Pro', status: 'pending' });
    data(await http.patch(`/admin/listings/${listing.id}/status`, { status: 'active' }, admin.token));

    const mail = (await mailTo(t, seller.email, (subject) => subject.includes('iPhone 14 Pro')))!;
    expect(mail).toBeDefined();
    expect(mail.subject).toBe('Your listing “iPhone 14 Pro” is now live on DOOAA');
    expect(mail.text).toContain('approved');
    expect(mail.html).toContain(`/products/${listing.id}`);
  });

  it('does not email the seller for a rejection (in-app only, as before)', async () => {
    const admin = await staffToken(t, 'admin');
    const listing = await createProduct(t, seller.id, { title: 'Blurry photo couch', status: 'pending' });
    data(await http.patch(`/admin/listings/${listing.id}/status`, { status: 'rejected', note: 'Photos too dark' }, admin.token));
    await t.mail.idle();
    expect(t.mail.lastTo(seller.email)?.subject ?? '').not.toContain('Blurry photo couch');
  });

  it('emails the alert address once about listings waiting over 2 hours', async () => {
    const queuedAt = new Date('2030-01-01T09:00:00Z');
    const waiting = await createProduct(t, seller.id, { title: 'PS5 Slim', status: 'pending' });
    await t.db.update(products, { id: waiting.id }, { pendingSince: queuedAt, pendingAlertedAt: null });
    const fresh = await createProduct(t, seller.id, { title: 'Fresh listing', status: 'pending' });
    await t.db.update(products, { id: fresh.id }, { pendingSince: new Date(queuedAt.getTime() + 90 * 60_000), pendingAlertedAt: null });

    // 1h59m in: too early.
    const early = await jobs.listingsJob(new Date(queuedAt.getTime() + 2 * HOUR - 60_000));
    expect(early.alerted).toBe(0);

    // Just past 2h: the old one is reported, the 30-minute-old one isn't.
    const due = new Date(queuedAt.getTime() + 2 * HOUR + 60_000);
    const first = await jobs.listingsJob(due);
    expect(first.alerted).toBeGreaterThanOrEqual(1);
    await t.mail.idle();
    const alert = t.mail.lastTo(ALERTS)!;
    expect(alert.subject).toMatch(/waiting over 2 hours for approval/);
    expect(alert.text).toContain('PS5 Slim');
    expect(alert.text).toContain(seller.firstName);
    expect(alert.text).not.toContain('Fresh listing');

    // Same listing, next run: no second email.
    const before = t.mail.sent.filter((mail) => mail.to === ALERTS).length;
    await jobs.listingsJob(new Date(due.getTime() + 10 * 60_000));
    await t.mail.idle();
    const after = t.mail.sent.filter((mail) => mail.to === ALERTS && mail.text.includes('PS5 Slim')).length;
    expect(after).toBeLessThanOrEqual(before);
    expect((await t.db.findOne(products, { id: waiting.id }))!.pendingAlertedAt).not.toBeNull();
  });

  it('restarts the clock when a listing is resubmitted for approval', async () => {
    const admin = await staffToken(t, 'admin');
    const listing = await createProduct(t, seller.id, { title: 'Resubmitted lamp', status: 'pending' });
    const old = new Date('2020-01-01T00:00:00Z');
    await t.db.update(products, { id: listing.id }, { pendingSince: old, pendingAlertedAt: new Date('2020-01-01T03:00:00Z') });
    // Staff send it back to review: the alert flag clears and the clock restarts.
    data(await http.patch(`/admin/listings/${listing.id}/status`, { status: 'suspicious' }, admin.token));
    data(await http.patch(`/admin/listings/${listing.id}/status`, { status: 'pending' }, admin.token));
    const row = (await t.db.findOne(products, { id: listing.id }))!;
    expect(row.pendingAlertedAt).toBeNull();
    expect(row.pendingSince!.getTime()).toBeGreaterThan(old.getTime());
  });
});
