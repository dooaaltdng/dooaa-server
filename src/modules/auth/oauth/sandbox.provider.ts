import type { OAuthProviderId } from '../../users/schemas/user.schema';
import { OAuthProviderError, type OAuthProfile, type OAuthProvider } from './oauth-provider';

/** Encodes the profile a sandbox "sign-in" returns. Tests craft their own; development gets a default. */
export function sandboxOAuthCode(profile: OAuthProfile): string {
  return Buffer.from(JSON.stringify(profile)).toString('base64url');
}

/**
 * Offline stand-in for Google/Facebook: the "provider" sends the browser
 * straight back to the callback with a code that carries the profile.
 * Refused in production by the config check.
 */
export class SandboxOAuthProvider implements OAuthProvider {
  readonly enabled = true;

  constructor(readonly id: OAuthProviderId) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const code = sandboxOAuthCode({
      subject: `sandbox-${this.id}-user`,
      email: `sandbox.${this.id}@dooaa.dev`,
      emailVerified: true,
      firstName: 'Sandbox',
      lastName: this.id === 'google' ? 'Google' : 'Facebook',
    });
    return `${redirectUri}?${new URLSearchParams({ code, state })}`;
  }

  async exchange({ code }: { code: string; redirectUri: string }): Promise<OAuthProfile> {
    let profile: Partial<OAuthProfile>;
    try {
      profile = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Partial<OAuthProfile>;
    } catch {
      throw new OAuthProviderError('Unreadable sandbox code');
    }
    if (!profile || typeof profile.subject !== 'string' || !profile.subject) throw new OAuthProviderError('Sandbox code has no subject');
    return {
      subject: profile.subject,
      email: typeof profile.email === 'string' ? profile.email.toLowerCase() : undefined,
      emailVerified: profile.emailVerified === true,
      firstName: profile.firstName,
      lastName: profile.lastName,
    };
  }
}
