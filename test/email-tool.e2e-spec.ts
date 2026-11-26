import { createTestApp, type TestApp } from './utils/app';
import { registerUser, staffToken, type TestUser } from './utils/factories';
import { Http, data } from './utils/http';

/**
 * The admin email tool. The last two tests cover the send guard: the same
 * campaign must reach each person once, however many times it is sent
 * (a second click, a retry, two clicks at once). They fail until the guard
 * exists in EmailToolService.send.
 */
describe('Admin email tool (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let token: string;
  let people: TestUser[];

  const sentTo = (email: string, subject: string) => t.mail.sent.filter((mail) => mail.to === email && mail.subject === subject).length;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    token = (await staffToken(t, 'admin')).token;
    people = [await registerUser(t, { firstName: 'Chidi', lastName: 'Okafor' }), await registerUser(t, { firstName: 'Amaka', lastName: 'Eze' })];
    await t.mail.idle();
  });
  afterAll(() => t.close());

  it('lists users with masked names and emails', async () => {
    const page = data(await http.get('/admin/email/users', token));
    const chidi = page.rows.find((row: { id: string }) => row.id === people[0].id);
    expect(chidi.name).toBe('Ch*** O*****');
    expect(chidi.email).not.toContain(people[0].email.split('@')[0]);
    expect(JSON.stringify(page)).not.toContain(people[0].email);
  });

  it('test mode emails only the test address, and hides it', async () => {
    const result = data(
      await http.post('/admin/email/send', { campaign: 'Test only', subject: 'Test only', message: 'Hello', mode: 'test', target: 'all' }, token),
    );
    await t.mail.idle();
    expect(sentTo('support@dooaa.ng', '[TEST] Test only')).toBe(1);
    for (const person of people) expect(sentTo(person.email, 'Test only')).toBe(0);
    expect(result.lines[0].recipient).toBe('test address (hidden)');
  });

  it('send guard: sending the same campaign twice emails each person once', async () => {
    const body = { campaign: 'Guard retry', subject: 'Guard retry', message: 'Hello', mode: 'live', target: 'selected', userIds: people.map((p) => p.id) };
    data(await http.post('/admin/email/send', body, token));
    data(await http.post('/admin/email/send', body, token)); // the retry
    await t.mail.idle();
    for (const person of people) expect(sentTo(person.email, 'Guard retry')).toBe(1);
  });

  it('send guard: two clicks at once email each person once', async () => {
    const body = { campaign: 'Guard double click', subject: 'Guard double click', message: 'Hello', mode: 'live', target: 'selected', userIds: people.map((p) => p.id) };
    await Promise.all([http.post('/admin/email/send', body, token), http.post('/admin/email/send', body, token)]);
    await t.mail.idle();
    for (const person of people) expect(sentTo(person.email, 'Guard double click')).toBe(1);
  });
});
