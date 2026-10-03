import { createHmac } from 'node:crypto';
import { FacebookOAuthProvider } from './facebook.provider';
import { GoogleOAuthProvider } from './google.provider';
import { OAuthProviderError } from './oauth-provider';
import { SandboxOAuthProvider, sandboxOAuthCode } from './sandbox.provider';
import { safeNext } from './oauth.service';

function respond(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

const REDIRECT = 'https://api.dooaa.ng/api/v1/auth/oauth/x/callback';

describe('OAuth providers', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => (fetchMock = jest.spyOn(globalThis, 'fetch')));
  afterEach(() => fetchMock.mockRestore());

  describe('Google', () => {
    const google = new GoogleOAuthProvider({ clientId: 'cid', clientSecret: 'secret' });

    it('is disabled without credentials', () => {
      expect(new GoogleOAuthProvider({ clientId: 'cid' }).enabled).toBe(false);
      expect(google.enabled).toBe(true);
    });

    it('trades the code for a token, then reads the profile', async () => {
      fetchMock
        .mockReturnValueOnce(respond(200, { access_token: 'ya29', id_token: 'jwt' }))
        .mockReturnValueOnce(respond(200, { sub: '1089', email: 'Ada@Example.com', email_verified: true, given_name: 'Ada', family_name: 'Obi' }));
      await expect(google.exchange({ code: 'auth-code', redirectUri: REDIRECT })).resolves.toEqual({
        subject: '1089',
        email: 'ada@example.com',
        emailVerified: true,
        firstName: 'Ada',
        lastName: 'Obi',
      });
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
      expect(Object.fromEntries(new URLSearchParams(String(tokenInit.body)))).toEqual({
        code: 'auth-code',
        client_id: 'cid',
        client_secret: 'secret',
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      });
      const [, infoInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect((infoInit.headers as Record<string, string>).Authorization).toBe('Bearer ya29');
    });

    it('treats a missing email_verified as unverified and splits a full name', async () => {
      fetchMock
        .mockReturnValueOnce(respond(200, { access_token: 'ya29' }))
        .mockReturnValueOnce(respond(200, { sub: '7', email: 'a@b.co', name: 'Ngozi Ama Uche' }));
      await expect(google.exchange({ code: 'c', redirectUri: REDIRECT })).resolves.toMatchObject({
        emailVerified: false,
        firstName: 'Ngozi',
        lastName: 'Ama Uche',
      });
    });

    it('fails on a rejected code', async () => {
      fetchMock.mockReturnValueOnce(respond(400, { error: 'invalid_grant' }));
      await expect(google.exchange({ code: 'bad', redirectUri: REDIRECT })).rejects.toBeInstanceOf(OAuthProviderError);
    });
  });

  describe('Facebook', () => {
    const facebook = new FacebookOAuthProvider({ appId: 'app', appSecret: 'shh', graphVersion: 'v21.0' });

    it('builds the dialog URL for the configured Graph version', () => {
      const url = new URL(facebook.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
      expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v21.0/dialog/oauth');
      expect(url.searchParams.get('scope')).toBe('email,public_profile');
      expect(url.searchParams.get('state')).toBe('s');
    });

    it('signs the profile request with appsecret_proof', async () => {
      fetchMock
        .mockReturnValueOnce(respond(200, { access_token: 'EAAB' }))
        .mockReturnValueOnce(respond(200, { id: '555', email: 'tolu@example.com', first_name: 'Tolu', last_name: 'Bello' }));
      await expect(facebook.exchange({ code: 'c', redirectUri: REDIRECT })).resolves.toEqual({
        subject: '555',
        email: 'tolu@example.com',
        emailVerified: true,
        firstName: 'Tolu',
        lastName: 'Bello',
      });
      const meUrl = new URL((fetchMock.mock.calls[1] as [string])[0]);
      expect(meUrl.pathname).toBe('/v21.0/me');
      expect(meUrl.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'shh').update('EAAB').digest('hex'));
    });

    it('reports no email as unverified', async () => {
      fetchMock.mockReturnValueOnce(respond(200, { access_token: 'EAAB' })).mockReturnValueOnce(respond(200, { id: '9', name: 'Phone Only' }));
      await expect(facebook.exchange({ code: 'c', redirectUri: REDIRECT })).resolves.toMatchObject({ email: undefined, emailVerified: false });
    });
  });

  describe('sandbox', () => {
    it('round-trips a profile through its code', async () => {
      const sandbox = new SandboxOAuthProvider('google');
      const profile = { subject: 's1', email: 'X@Y.co', emailVerified: true, firstName: 'X', lastName: 'Y' };
      await expect(sandbox.exchange({ code: sandboxOAuthCode(profile), redirectUri: REDIRECT })).resolves.toEqual({ ...profile, email: 'x@y.co' });
    });

    it('redirects straight back to the callback with the state', () => {
      const url = new URL(new SandboxOAuthProvider('facebook').authorizeUrl({ state: 'st', redirectUri: REDIRECT }));
      expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
      expect(url.searchParams.get('state')).toBe('st');
    });

    it('rejects junk', async () => {
      await expect(new SandboxOAuthProvider('google').exchange({ code: 'junk', redirectUri: REDIRECT })).rejects.toBeInstanceOf(OAuthProviderError);
    });
  });

  describe('safeNext', () => {
    it.each([
      ['/orders', '/orders'],
      ['/products/1?x=2', '/products/1?x=2'],
      ['//evil.example', ''],
      ['/\\evil.example', ''],
      ['https://evil.example', ''],
      ['orders', ''],
      ['/a\nb', ''],
      [undefined, ''],
    ])('%p → %p', (input, expected) => expect(safeNext(input)).toBe(expected));
  });
});
