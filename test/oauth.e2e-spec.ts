import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { createTestApp, type TestApp } from './utils/app';
import { API, Http, data, failure } from './utils/http';
import { PASSWORD, registerUser, uniqueEmail } from './utils/factories';
import { OAuthGrant } from '../src/modules/auth/oauth/oauth-grant.schema';
import type { OAuthProfile } from '../src/modules/auth/oauth/oauth-provider';
import { sandboxOAuthCode } from '../src/modules/auth/oauth/sandbox.provider';
import { User } from '../src/modules/users/schemas/user.schema';

const CLIENT = 'http://localhost:3000';
const CALLBACK = 'http://localhost:4000/api/v1/auth/oauth/google/callback';

describe('Social sign-in (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let users: Model<User>;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    users = t.get<Model<User>>(getModelToken(User.name));
  });
  afterAll(async () => t.close());

  const profile = (overrides: Partial<OAuthProfile> = {}): OAuthProfile => ({
    subject: `g-${Math.random().toString(36).slice(2)}`,
    email: uniqueEmail('social'),
    emailVerified: true,
    firstName: 'Chioma',
    lastName: 'Eze',
    ...overrides,
  });

  /** Starts a sign-in and returns what the browser would carry back: the state and the nonce cookie. */
  async function start(provider = 'google', next?: string) {
    const response = await request(t.server)
      .get(`${API}/auth/oauth/${provider}/start`)
      .query(next === undefined ? {} : { next });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    const cookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((value) => value.startsWith('dooaa_oauth='));
    return { location, state: location.searchParams.get('state') ?? '', nonce: cookie?.split(';')[0].split('=')[1] ?? '', cookie };
  }

  async function callback(provider: string, query: Record<string, string>, nonce?: string) {
    let call = request(t.server).get(`${API}/auth/oauth/${provider}/callback`).query(query);
    if (nonce !== undefined) call = call.set('Cookie', `dooaa_oauth=${nonce}`);
    const response = await call;
    expect(response.status).toBe(302);
    return new URL(response.headers.location);
  }

  /** The whole round trip for a profile; returns the client redirect. */
  async function roundTrip(who: OAuthProfile, provider = 'google', next?: string) {
    const { state, nonce } = await start(provider, next);
    return callback(provider, { code: sandboxOAuthCode(who), state }, nonce);
  }

  async function signIn(who: OAuthProfile, provider = 'google', next?: string) {
    const landing = await roundTrip(who, provider, next);
    expect(`${landing.origin}${landing.pathname}`).toBe(`${CLIENT}/auth/callback`);
    const response = await http.post('/auth/oauth/exchange', { code: landing.searchParams.get('code') });
    return { body: data(response), response };
  }

  const errorOf = (landing: URL) => {
    expect(`${landing.origin}${landing.pathname}`).toBe(`${CLIENT}/sign-in`);
    return landing.searchParams.get('error');
  };

  describe('providers', () => {
    it('lists Google and Facebook as available', async () => {
      expect(data(await http.get('/auth/oauth/providers'))).toEqual({
        providers: [
          { id: 'google', enabled: true },
          { id: 'facebook', enabled: true },
        ],
      });
    });
  });

  describe('start', () => {
    it('sends the browser to the provider with a signed state and sets a lax, httpOnly nonce cookie', async () => {
      const { location, state, cookie } = await start('google');
      expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
      expect(state.split('.')).toHaveLength(3);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth\/oauth/);
    });

    it('sends an unknown provider back to sign-in with a code', async () => {
      const response = await request(t.server).get(`${API}/auth/oauth/twitter/start`);
      expect(response.status).toBe(302);
      expect(errorOf(new URL(response.headers.location))).toBe('OAUTH_PROVIDER_UNKNOWN');
    });

    it('rejects a malformed next parameter', async () => {
      failure(await http.get(`/auth/oauth/google/start?next=${'a'.repeat(600)}`), 400, 'VALIDATION_FAILED');
    });
  });

  describe('first sign-in', () => {
    it('creates a verified account with no role and hands out a working session', async () => {
      const who = profile();
      const { body, response } = await signIn(who);
      expect(body.isNewUser).toBe(true);
      expect(body.next).toBeNull();
      expect(body.user).toMatchObject({ email: who.email, firstName: 'Chioma', lastName: 'Eze', verified: true, role: null, phone: '' });
      expect(body.tokens.refreshToken).toMatch(/^u\./);
      expect(([] as string[]).concat(response.headers['set-cookie'] ?? []).some((c) => c.startsWith('dooaa_rt='))).toBe(true);

      const me = data(await http.get('/auth/me', body.tokens.accessToken));
      expect(me.id).toBe(body.user.id);

      const stored = await users.findById(body.user.id).select('+passwordHash').lean();
      expect(stored?.oauth).toEqual([expect.objectContaining({ provider: 'google', subject: who.subject, email: who.email })]);
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
      await t.mail.idle();
      expect(t.mail.lastTo(who.email!)?.subject).toBe('Welcome to DOOAA');
    });

    it('cannot be signed into with a guessed password', async () => {
      const who = profile();
      await signIn(who);
      failure(await http.post('/auth/sign-in', { email: who.email, password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
    });

    it('falls back to the email for a missing name', async () => {
      const who = profile({ firstName: undefined, lastName: undefined, email: `kemi.ade.${Date.now()}@example.com` });
      const { body } = await signIn(who);
      expect(body.user.firstName).toBe('kemi ade');
      expect(body.user.lastName).toBe('User');
    });

    it('keeps a same-site next path and drops anything else', async () => {
      expect((await signIn(profile(), 'google', '/orders?tab=open')).body.next).toBe('/orders?tab=open');
      expect((await signIn(profile(), 'google', '//evil.example/x')).body.next).toBeNull();
      expect((await signIn(profile(), 'google', 'https://evil.example')).body.next).toBeNull();
    });

    it('works the same through Facebook', async () => {
      const who = profile();
      const { body } = await signIn(who, 'facebook');
      expect(body.isNewUser).toBe(true);
      const stored = await users.findById(body.user.id).lean();
      expect(stored?.oauth?.[0]).toMatchObject({ provider: 'facebook', subject: who.subject });
    });
  });

  describe('returning and linking', () => {
    it('signs a returning identity into the same account, even after its email changed at the provider', async () => {
      const who = profile();
      const first = await signIn(who);
      const again = await signIn({ ...who, email: uniqueEmail('changed') });
      expect(again.body.isNewUser).toBe(false);
      expect(again.body.user.id).toBe(first.body.user.id);
    });

    it('links to an existing verified account by email and leaves its password working', async () => {
      const existing = await registerUser(t);
      const { body } = await signIn(profile({ email: existing.email.toUpperCase() }));
      expect(body.isNewUser).toBe(false);
      expect(body.user.id).toBe(existing.id);
      expect(body.user.role).toBe('buyer');
      data(await http.post('/auth/sign-in', { email: existing.email, password: PASSWORD }));
      await t.mail.idle();
      expect(t.mail.lastTo(existing.email)?.subject).toBe('Google sign-in added to your DOOAA account');
    });

    it('takes over an account whose email was never verified: the old password and sessions die', async () => {
      const squatter = await registerUser(t, { verifyEmail: false });
      const { body } = await signIn(profile({ email: squatter.email }));
      expect(body.user).toMatchObject({ id: squatter.id, verified: true });
      failure(await http.post('/auth/sign-in', { email: squatter.email, password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
      failure(await http.post('/auth/refresh', { refreshToken: squatter.refreshToken }), 401);
      failure(await http.get('/auth/me', squatter.token), 401);
      data(await http.get('/auth/me', body.tokens.accessToken));
    });

    it('can link both providers to one account', async () => {
      const email = uniqueEmail('both');
      const viaGoogle = await signIn(profile({ email }), 'google');
      const viaFacebook = await signIn(profile({ email }), 'facebook');
      expect(viaFacebook.body.user.id).toBe(viaGoogle.body.user.id);
      const stored = await users.findById(viaGoogle.body.user.id).lean();
      expect(stored?.oauth?.map((identity) => identity.provider).sort()).toEqual(['facebook', 'google']);
    });
  });

  describe('refusals', () => {
    it('refuses a provider email it has not verified', async () => {
      expect(errorOf(await roundTrip(profile({ emailVerified: false })))).toBe('OAUTH_EMAIL_UNVERIFIED');
    });

    it('refuses an identity with no email', async () => {
      expect(errorOf(await roundTrip(profile({ email: undefined })))).toBe('OAUTH_EMAIL_REQUIRED');
    });

    it('refuses banned and closed accounts, linked or not', async () => {
      const banned = await registerUser(t);
      await users.updateOne({ _id: banned.id }, { $set: { status: 'banned' } });
      expect(errorOf(await roundTrip(profile({ email: banned.email })))).toBe('ACCOUNT_BANNED');

      const who = profile();
      const { body } = await signIn(who);
      await users.updateOne({ _id: body.user.id }, { $set: { status: 'closed' } });
      expect(errorOf(await roundTrip(who))).toBe('ACCOUNT_CLOSED');
    });

    it('refuses a callback without the nonce cookie (login CSRF)', async () => {
      const { state } = await start();
      expect(errorOf(await callback('google', { code: sandboxOAuthCode(profile()), state }))).toBe('OAUTH_STATE_INVALID');
    });

    it('refuses a nonce from another browser, a forged state and a state for the other provider', async () => {
      const mine = await start();
      const theirs = await start();
      const code = sandboxOAuthCode(profile());
      expect(errorOf(await callback('google', { code, state: mine.state }, theirs.nonce))).toBe('OAUTH_STATE_INVALID');
      expect(errorOf(await callback('google', { code, state: `${mine.state}x` }, mine.nonce))).toBe('OAUTH_STATE_INVALID');
      expect(errorOf(await callback('facebook', { code, state: mine.state }, mine.nonce))).toBe('OAUTH_STATE_INVALID');
    });

    it('reports a cancelled consent screen', async () => {
      const { state, nonce } = await start();
      expect(errorOf(await callback('google', { error: 'access_denied', state }, nonce))).toBe('OAUTH_CANCELLED');
    });

    it('reports a provider failure without leaking details', async () => {
      const { state, nonce } = await start();
      expect(errorOf(await callback('google', { code: 'not-a-sandbox-code', state }, nonce))).toBe('OAUTH_FAILED');
    });

    it('ignores extra parameters the provider appends', async () => {
      const { state, nonce } = await start();
      const landing = await callback('google', { code: sandboxOAuthCode(profile()), state, scope: 'email openid', authuser: '0', iss: 'https://accounts.google.com' }, nonce);
      expect(landing.pathname).toBe('/auth/callback');
    });
  });

  describe('exchange', () => {
    it('works once', async () => {
      const landing = await roundTrip(profile());
      const code = landing.searchParams.get('code');
      data(await http.post('/auth/oauth/exchange', { code }));
      failure(await http.post('/auth/oauth/exchange', { code }), 400, 'OAUTH_CODE_INVALID');
    });

    it('stores only a hash of the code', async () => {
      const landing = await roundTrip(profile());
      const code = landing.searchParams.get('code')!;
      const grants = t.get<Model<OAuthGrant>>(getModelToken(OAuthGrant.name));
      expect(await grants.countDocuments({ codeHash: code })).toBe(0);
    });

    it('expires', async () => {
      const landing = await roundTrip(profile());
      const grants = t.get<Model<OAuthGrant>>(getModelToken(OAuthGrant.name));
      await grants.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      failure(await http.post('/auth/oauth/exchange', { code: landing.searchParams.get('code') }), 400, 'OAUTH_CODE_INVALID');
    });

    it('refuses an account banned between the callback and the exchange', async () => {
      const who = profile();
      const landing = await roundTrip(who);
      await users.updateOne({ email: who.email }, { $set: { status: 'banned' } });
      failure(await http.post('/auth/oauth/exchange', { code: landing.searchParams.get('code') }), 403, 'ACCOUNT_BANNED');
    });

    it('validates the code', async () => {
      failure(await http.post('/auth/oauth/exchange', {}), 400, 'VALIDATION_FAILED');
      failure(await http.post('/auth/oauth/exchange', { code: 'x'.repeat(40) }), 400, 'OAUTH_CODE_INVALID');
    });
  });
});

describe('Social sign-in with live providers (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { OAUTH_DRIVER: 'live', GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret', FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '' } });
  });
  afterAll(async () => t.close());

  it('only offers providers that have credentials', async () => {
    expect(data(await new Http(t).get('/auth/oauth/providers')).providers).toEqual([
      { id: 'google', enabled: true },
      { id: 'facebook', enabled: false },
    ]);
  });

  it('sends the browser to Google with the registered callback URL', async () => {
    const response = await request(t.server).get(`${API}/auth/oauth/google/start`);
    const location = new URL(response.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: 'google-client',
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'openid email profile',
    });
  });

  it('sends an unconfigured provider back to sign-in', async () => {
    const response = await request(t.server).get(`${API}/auth/oauth/facebook/start`);
    expect(new URL(response.headers.location).searchParams.get('error')).toBe('OAUTH_UNAVAILABLE');
  });
});
