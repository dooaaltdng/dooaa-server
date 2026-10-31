import { createTestApp, type TestApp } from './utils/app';
import { registerSeller, registerUser } from './utils/factories';
import { Http, data, failure } from './utils/http';

describe('Store names (e2e)', () => {
  let t: TestApp;
  let http: Http;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
  });
  afterAll(() => t.close());

  it('gives each store name to one store only, ignoring case, spaces and punctuation', async () => {
    const first = await registerSeller(t);
    const second = await registerUser(t, { role: 'seller' });
    expect(data(await http.patch('/me', { storeName: 'Ada Gadgets' }, first.token)).storeName).toBe('Ada Gadgets');
    failure(await http.patch('/me', { storeName: 'ada-gadgets' }, second.token), 409, 'STORE_NAME_TAKEN');
    failure(await http.patch('/me', { storeName: '  ADA   GADGETS ' }, second.token), 409, 'STORE_NAME_TAKEN');
    // Saving your own name again is fine.
    expect(data(await http.patch('/me', { storeName: 'Ada Gadgets' }, first.token)).storeName).toBe('Ada Gadgets');
  });

  it('keeps DOOAA for DOOAA', async () => {
    const seller = await registerUser(t, { role: 'seller' });
    for (const name of ['DOOAA Renewable', 'dooaa', 'D.O.O.A.A Store', 'My Dooaa Shop']) {
      failure(await http.patch('/me', { storeName: name }, seller.token), 409, 'STORE_NAME_RESERVED');
    }
  });
});
