import { createHmac } from 'node:crypto';
import { OAuthProviderError, readJson, type OAuthProfile, type OAuthProvider } from './oauth-provider';

type FacebookMe = { id: string; email?: string; first_name?: string; last_name?: string; name?: string };

/** Facebook Login (authorization-code flow against the Graph API). */
export class FacebookOAuthProvider implements OAuthProvider {
  readonly id = 'facebook' as const;

  constructor(private readonly credentials: { appId?: string; appSecret?: string; graphVersion: string }) {}

  get enabled(): boolean {
    return Boolean(this.credentials.appId && this.credentials.appSecret);
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.credentials.appId ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email,public_profile',
      state,
    });
    return `https://www.facebook.com/${this.credentials.graphVersion}/dialog/oauth?${params}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthProfile> {
    const graph = `https://graph.facebook.com/${this.credentials.graphVersion}`;
    const tokenParams = new URLSearchParams({
      client_id: this.credentials.appId ?? '',
      client_secret: this.credentials.appSecret ?? '',
      redirect_uri: redirectUri,
      code,
    });
    const token = await readJson<{ access_token?: string }>(
      await fetch(`${graph}/oauth/access_token?${tokenParams}`, { headers: { Accept: 'application/json' } }),
      'Facebook token exchange',
    );
    if (!token.access_token) throw new OAuthProviderError('Facebook returned no access token');

    const proof = createHmac('sha256', this.credentials.appSecret ?? '').update(token.access_token).digest('hex');
    const meParams = new URLSearchParams({
      fields: 'id,email,first_name,last_name,name',
      access_token: token.access_token,
      appsecret_proof: proof,
    });
    const me = await readJson<FacebookMe>(await fetch(`${graph}/me?${meParams}`, { headers: { Accept: 'application/json' } }), 'Facebook profile');
    if (!me.id) throw new OAuthProviderError('Facebook returned no account id');
    return {
      subject: String(me.id),
      email: me.email?.toLowerCase(),
      // Facebook only shares an email address the person has confirmed.
      emailVerified: Boolean(me.email),
      firstName: me.first_name ?? me.name?.split(' ')[0],
      lastName: me.last_name ?? me.name?.split(' ').slice(1).join(' '),
    };
  }
}
