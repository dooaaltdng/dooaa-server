import type { OAuthProviderId } from '../../users/schemas/user.schema';

/** Who the provider says signed in. Only `subject` is guaranteed. */
export type OAuthProfile = {
  subject: string;
  email?: string;
  /** Whether the provider vouches that the person controls `email`. */
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
};

/**
 * One social sign-in provider: where to send the person, and how to turn
 * the code it sends back into a profile. Tokens from the provider are used
 * once to read the profile and never stored.
 */
export interface OAuthProvider {
  readonly id: OAuthProviderId;
  /** False when its credentials are not configured; the button is hidden. */
  readonly enabled: boolean;
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchange(input: { code: string; redirectUri: string }): Promise<OAuthProfile>;
}

export const OAUTH_PROVIDER_REGISTRY = Symbol('OAUTH_PROVIDER_REGISTRY');
export type OAuthProviderRegistry = Record<OAuthProviderId, OAuthProvider>;

export class OAuthProviderError extends Error {}

export async function readJson<T>(response: Response, what: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || !body) throw new OAuthProviderError(`${what} failed with HTTP ${response.status}`);
  return body;
}
