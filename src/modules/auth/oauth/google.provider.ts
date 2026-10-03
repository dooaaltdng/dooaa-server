import { OAuthProviderError, readJson, type OAuthProfile, type OAuthProvider } from './oauth-provider';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

type GoogleUserInfo = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
};

/** Google sign-in (OpenID Connect, authorization-code flow). */
export class GoogleOAuthProvider implements OAuthProvider {
  readonly id = 'google' as const;

  constructor(private readonly credentials: { clientId?: string; clientSecret?: string }) {}

  get enabled(): boolean {
    return Boolean(this.credentials.clientId && this.credentials.clientSecret);
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.credentials.clientId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthProfile> {
    const token = await readJson<{ access_token?: string }>(
      await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: this.credentials.clientId ?? '',
          client_secret: this.credentials.clientSecret ?? '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      }),
      'Google token exchange',
    );
    if (!token.access_token) throw new OAuthProviderError('Google returned no access token');

    // Read straight from Google over TLS, so the id_token signature need not be checked separately.
    const info = await readJson<GoogleUserInfo>(
      await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } }),
      'Google userinfo',
    );
    if (!info.sub) throw new OAuthProviderError('Google returned no account id');
    return {
      subject: String(info.sub),
      email: info.email?.toLowerCase(),
      emailVerified: info.email_verified === true,
      firstName: info.given_name ?? info.name?.split(' ')[0],
      lastName: info.family_name ?? info.name?.split(' ').slice(1).join(' '),
    };
  }
}
