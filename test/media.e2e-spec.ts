import request from 'supertest';
import { v2 as cloudinary } from 'cloudinary';
import { createTestApp, type TestApp } from './utils/app';
import { API, Http, data, failure } from './utils/http';
import { registerUser, staffToken } from './utils/factories';
import { FILES } from './utils/files';

describe('Media uploads (e2e, memory storage)', () => {
  let t: TestApp;
  let http: Http;
  let user: Awaited<ReturnType<typeof registerUser>>;

  const upload = (token: string, purpose: string, buffer: Buffer, filename: string) =>
    request(t.server).post(`${API}/media`).set('Authorization', `Bearer ${token}`).field('purpose', purpose).attach('file', buffer, filename);

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    user = await registerUser(t);
  });
  afterAll(async () => t.close());

  it('stores a public image and serves it back with the real content type', async () => {
    const media = data(await upload(user.token, 'product', FILES.jpeg(), 'phone.jpg'), 201);
    expect(media).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', purpose: 'product', visibility: 'public', name: 'phone.jpg', posterUrl: null });
    const path = new URL(media.url).pathname;
    const served = await request(t.server).get(path);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['cache-control']).toContain('immutable');
  });

  it('identifies files by their bytes, not their name', async () => {
    const media = data(await upload(user.token, 'message', FILES.png(), 'looks-like.pdf'));
    expect(media.mimeType).toBe('image/png');
    failure(await upload(user.token, 'product', FILES.script(), 'evil.jpg'), 400, 'UNSUPPORTED_FILE');
  });

  it('enforces what each purpose accepts', async () => {
    failure(await upload(user.token, 'avatar', FILES.pdf(), 'cv.pdf'), 400, 'UNSUPPORTED_FILE');
    failure(await upload(user.token, 'evidence', FILES.pdf(), 'claim.pdf'), 400, 'UNSUPPORTED_FILE');
    data(await upload(user.token, 'product', FILES.mp4(), 'clip.mp4'));
    data(await upload(user.token, 'kyc', FILES.pdf(), 'passport.pdf'));
  });

  it('requires a file and a known purpose', async () => {
    const empty = await request(t.server).post(`${API}/media`).set('Authorization', `Bearer ${user.token}`).field('purpose', 'product');
    failure(empty, 400, 'FILE_REQUIRED');
    failure(await upload(user.token, 'content', FILES.jpeg(), 'x.jpg'), 400, 'VALIDATION_FAILED');
  });

  it('rejects files over the size limit', async () => {
    const t2 = await createTestApp({ env: { MAX_IMAGE_MB: '0.0001' } });
    try {
      const owner = await registerUser(t2);
      const response = await request(t2.server)
        .post(`${API}/media`)
        .set('Authorization', `Bearer ${owner.token}`)
        .field('purpose', 'product')
        .attach('file', FILES.jpeg(), 'big.jpg');
      failure(response, 400, 'FILE_TOO_LARGE');
    } finally {
      await t2.close();
    }
  });

  it('keeps identity documents private behind expiring signed links', async () => {
    const media = data(await upload(user.token, 'kyc', FILES.jpeg(), 'id-front.jpg'));
    expect(media.visibility).toBe('private');
    const url = new URL(media.url);
    expect(url.searchParams.get('sig')).toBeTruthy();

    const ok = await request(t.server).get(`${url.pathname}${url.search}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');

    failure(await request(t.server).get(url.pathname), 403, 'LINK_EXPIRED');
    const tampered = `${url.pathname}?expires=${url.searchParams.get('expires')}&sig=${'A'.repeat(43)}`;
    failure(await request(t.server).get(tampered), 403, 'LINK_EXPIRED');
    const past = `${url.pathname}?expires=1&sig=${url.searchParams.get('sig')}`;
    failure(await request(t.server).get(past), 403, 'LINK_EXPIRED');
  });

  it('lets only the owner delete an upload', async () => {
    const media = data(await upload(user.token, 'message', FILES.jpeg(), 'a.jpg'));
    const other = await registerUser(t);
    failure(await http.delete(`/media/${media.id}`, other.token), 404);
    expect(data(await http.delete(`/media/${media.id}`, user.token))).toEqual({ deleted: true });
    failure(await request(t.server).get(new URL(media.url).pathname), 404);
  });

  it('requires sign-in to upload', async () => {
    failure(await request(t.server).post(`${API}/media`).field('purpose', 'product').attach('file', FILES.jpeg(), 'a.jpg'), 401);
  });

  it('lets staff upload console content', async () => {
    const staff = await staffToken(t, 'admin');
    const response = await request(t.server)
      .post(`${API}/admin/media`)
      .set('Authorization', `Bearer ${staff.token}`)
      .field('purpose', 'content')
      .attach('file', FILES.png(), 'banner.png');
    expect(data(response).purpose).toBe('content');
  });

  it('explains that direct uploads need Cloudinary', async () => {
    failure(await http.post('/media/uploads', { purpose: 'product', kind: 'video', name: 'clip.mp4', size: 1000 }, user.token), 400, 'DIRECT_UPLOAD_UNAVAILABLE');
  });
});

describe('Media uploads (e2e, Cloudinary)', () => {
  let t: TestApp;
  let http: Http;
  let user: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    t = await createTestApp({
      env: { STORAGE_DRIVER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'dooaa-test', CLOUDINARY_API_KEY: '1234', CLOUDINARY_API_SECRET: 'shhh' },
    });
    http = new Http(t);
    user = await registerUser(t);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await t.close();
  });

  it('streams proxied uploads to Cloudinary and returns the CDN URL with a video poster', async () => {
    const calls: Array<Record<string, unknown>> = [];
    jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: Record<string, unknown>, callback: (error: unknown, result: unknown) => void) => {
      calls.push(options);
      return {
        end: () =>
          callback(undefined, {
            secure_url: `https://res.cloudinary.com/dooaa-test/video/upload/${String(options.public_id)}.mp4`,
          }),
      };
    }) as never);

    const response = await request(t.server)
      .post(`${API}/media`)
      .set('Authorization', `Bearer ${user.token}`)
      .field('purpose', 'product')
      .attach('file', FILES.mp4(), 'clip.mp4');
    const media = data(response);
    expect(calls[0]).toMatchObject({ resource_type: 'video', type: 'upload', overwrite: false });
    expect(String(calls[0].public_id)).toMatch(/^dooaa\/product\/\d{4}\/\d{2}\/[a-f0-9]{24}$/);
    expect(media.url).toMatch(/^https:\/\/res\.cloudinary\.com\/dooaa-test\/video\/upload\//);
    expect(media.posterUrl).toMatch(/so_0/);
    expect(media.posterUrl).toMatch(/\.jpg(\?|$)/);
  });

  it('keeps PDFs as raw assets with their extension, and private documents authenticated', async () => {
    const calls: Array<Record<string, unknown>> = [];
    jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: Record<string, unknown>, callback: (error: unknown, result: unknown) => void) => {
      calls.push(options);
      return { end: () => callback(undefined, { secure_url: 'https://res.cloudinary.com/x/raw/authenticated/doc.pdf' }) };
    }) as never);
    const response = await request(t.server)
      .post(`${API}/media`)
      .set('Authorization', `Bearer ${user.token}`)
      .field('purpose', 'kyc')
      .attach('file', FILES.pdf(), 'passport.pdf');
    const media = data(response);
    expect(calls[0]).toMatchObject({ resource_type: 'raw', type: 'authenticated' });
    expect(String(calls[0].public_id)).toMatch(/\.pdf$/);
    expect(media.visibility).toBe('private');

    // Our signed link redirects to a short-lived Cloudinary private download.
    const url = new URL(media.url);
    const served = await request(t.server).get(`${url.pathname}${url.search}`);
    expect(served.status).toBe(302);
    expect(served.headers.location).toMatch(/^https:\/\/api\.cloudinary\.com\/v1_1\/dooaa-test\/raw\/download\?/);
    expect(served.headers.location).toMatch(/expires_at=\d+/);
  });

  it('reports a storage outage as a provider error', async () => {
    jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((_options: unknown, callback: (error: unknown) => void) => ({
      end: () => callback(new Error('Cloudinary is down')),
    })) as never);
    const response = await request(t.server)
      .post(`${API}/media`)
      .set('Authorization', `Bearer ${user.token}`)
      .field('purpose', 'product')
      .attach('file', FILES.jpeg(), 'a.jpg');
    failure(response, 502, 'STORAGE_ERROR');
  });

  it('signs direct uploads for one object and registers it once Cloudinary confirms it', async () => {
    const start = data(await http.post('/media/uploads', { purpose: 'product', kind: 'video', name: 'walkaround.mov', size: 20 * 1024 * 1024 }, user.token));
    expect(start.upload.uploadUrl).toBe('https://api.cloudinary.com/v1_1/dooaa-test/video/upload');
    const fields = start.upload.fields;
    expect(fields).toMatchObject({ api_key: '1234', type: 'upload', allowed_formats: 'mp4,mov,webm', overwrite: 'false' });
    expect(fields.signature).toMatch(/^[a-f0-9]{40}$/);
    expect(String(fields.public_id)).toMatch(/^dooaa\/product\//);
    // The signature covers exactly these parameters.
    const { api_key: _key, signature, ...signed } = fields;
    expect(cloudinary.utils.api_sign_request(signed, 'shhh')).toBe(signature);

    const resource = jest.spyOn(cloudinary.api, 'resource').mockResolvedValue({
      bytes: 18_000_000,
      format: 'mov',
      secure_url: `https://res.cloudinary.com/dooaa-test/video/upload/${fields.public_id}.mov`,
    } as never);
    const media = data(await http.post('/media/uploads/confirm', { ticket: start.ticket }, user.token));
    expect(resource).toHaveBeenCalledWith(fields.public_id, { resource_type: 'video', type: 'upload' });
    expect(media).toMatchObject({ kind: 'video', mimeType: 'video/quicktime', size: 18_000_000, purpose: 'product' });
    expect(media.posterUrl).toContain('so_0');

    // Confirming twice is idempotent.
    expect(data(await http.post('/media/uploads/confirm', { ticket: start.ticket }, user.token)).id).toBe(media.id);
  });

  it('deletes and refuses a direct upload that is too big or the wrong format', async () => {
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' } as never);
    const big = data(await http.post('/media/uploads', { purpose: 'product', kind: 'image', name: 'a.jpg', size: 1000 }, user.token));
    jest.spyOn(cloudinary.api, 'resource').mockResolvedValue({ bytes: 50 * 1024 * 1024, format: 'jpg', secure_url: 'https://x' } as never);
    failure(await http.post('/media/uploads/confirm', { ticket: big.ticket }, user.token), 400, 'FILE_TOO_LARGE');

    const wrong = data(await http.post('/media/uploads', { purpose: 'product', kind: 'image', name: 'a.jpg', size: 1000 }, user.token));
    jest.spyOn(cloudinary.api, 'resource').mockResolvedValue({ bytes: 1000, format: 'svg', secure_url: 'https://x' } as never);
    failure(await http.post('/media/uploads/confirm', { ticket: wrong.ticket }, user.token), 400, 'UNSUPPORTED_FILE');
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('will not confirm an upload that never arrived, or someone else’s ticket', async () => {
    const start = data(await http.post('/media/uploads', { purpose: 'message', kind: 'image', name: 'a.jpg', size: 1000 }, user.token));
    jest.spyOn(cloudinary.api, 'resource').mockRejectedValue({ error: { http_code: 404 } } as never);
    failure(await http.post('/media/uploads/confirm', { ticket: start.ticket }, user.token), 400, 'UPLOAD_NOT_FOUND');

    const other = await registerUser(t);
    failure(await http.post('/media/uploads/confirm', { ticket: start.ticket }, other.token), 403, 'UPLOAD_TICKET_INVALID');
    failure(await http.post('/media/uploads/confirm', { ticket: `${start.ticket}x` }, user.token), 400, 'UPLOAD_TICKET_INVALID');
  });

  it('checks kind and size before signing anything', async () => {
    failure(await http.post('/media/uploads', { purpose: 'avatar', kind: 'video', name: 'a.mp4', size: 1000 }, user.token), 400, 'UNSUPPORTED_FILE');
    failure(await http.post('/media/uploads', { purpose: 'product', kind: 'video', name: 'a.mp4', size: 400 * 1024 * 1024 }, user.token), 400, 'FILE_TOO_LARGE');
  });
});
