import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, gt, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AppError, Errors } from '../../../common/api/app-error';
import { OAUTH_PROVIDERS, type OAuthProviderId } from '../../../common/domain';
import { InjectConfig } from '../../../config/config.module';
import type { AppConfig } from '../../../config/configuration';
import { InjectDb, type Database } from '../../../database/database';
import { oauthGrants, userOauthIdentities, users } from '../../../database/schema';
import { MailService } from '../../mail/mail.service';
import { PasswordService } from '../../users/password.service';
import { toUser, userColumns, type User } from '../../users/user.model';
import { toPublicUser } from '../../users/user.presenter';
import { UsersService } from '../../users/users.service';
import { AuthService, type AuthResult } from '../auth.service';
import { TokenService, hashToken, type SessionMeta } from '../token.service';
import { OAUTH_PROVIDER_REGISTRY, type OAuthProfile, type OAuthProviderRegistry } from './oauth-provider';

const STATE_TTL_SECONDS = 10 * 60;
const GRANT_TTL_MS = 2 * 60 * 1000;

type StatePayload = { typ: 'oauth-state'; p: OAuthProviderId; n: string; next: string };

export type OAuthStart = { url: string; nonce: string };
export type OAuthExchangeResult = AuthResult & { isNewUser: boolean; next: string | null };

/** Only same-site paths survive the round trip, so the sign-in cannot bounce anyone elsewhere. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string') return '';
  const value = next.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.length > 500) return '';
  return /[\u0000-\u001f]/.test(value) ? '' : value;
}

/**
 * Google and Facebook sign-in. The browser goes provider → our callback →
 * the client's /auth/callback with a one-time code, which the client trades
 * for the same session a password sign-in gets.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    @Inject(OAUTH_PROVIDER_REGISTRY) private readonly providers: OAuthProviderRegistry,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectDb() private readonly db: Database,
  ) {}

  list(): { providers: { id: OAuthProviderId; enabled: boolean }[] } {
    return { providers: OAUTH_PROVIDERS.map((id) => ({ id, enabled: this.providers[id].enabled })) };
  }

  /** The client page every outcome lands on. */
  clientRedirect(params: Record<string, string>): string {
    const path = 'error' in params ? '/sign-in' : '/auth/callback';
    return `${this.config.clientUrl}${path}?${new URLSearchParams(params)}`;
  }

  redirectUri(provider: OAuthProviderId): string {
    return `${this.config.appUrl}/api/v1/auth/oauth/${provider}/callback`;
  }

  private provider(id: string) {
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(id)) throw Errors.notFound('We do not support that sign-in method.', 'OAUTH_PROVIDER_UNKNOWN');
    const provider = this.providers[id as OAuthProviderId];
    if (!provider.enabled) throw Errors.unavailable('That sign-in method is not available right now.', 'OAUTH_UNAVAILABLE');
    return provider;
  }

  private stateSecret(): string {
    return `${this.config.jwt.refreshSecret}:oauth-state`;
  }

  /**
   * Builds the provider URL. The state is signed and carries a nonce that
   * must match the cookie set on this browser, so a callback started in
   * someone else's browser (login CSRF) is refused.
   */
  async start(providerId: string, next?: string): Promise<OAuthStart> {
    const provider = this.provider(providerId);
    const nonce = randomBytes(16).toString('base64url');
    const payload: StatePayload = { typ: 'oauth-state', p: provider.id, n: nonce, next: safeNext(next) };
    const state = await this.jwt.signAsync(payload, { secret: this.stateSecret(), expiresIn: STATE_TTL_SECONDS, audience: 'dooaa-oauth' });
    return { url: provider.authorizeUrl({ state, redirectUri: this.redirectUri(provider.id) }), nonce };
  }

  /** Verifies the round trip, signs the person in (or up) and returns the client redirect with a one-time code. */
  async callback(providerId: string, query: { code?: string; state?: string; error?: string }, nonce: string | undefined): Promise<string> {
    const provider = this.provider(providerId);
    if (query.error) throw Errors.badRequest('Sign-in was cancelled.', 'OAUTH_CANCELLED');

    let state: StatePayload;
    try {
      state = await this.jwt.verifyAsync<StatePayload>(query.state ?? '', { secret: this.stateSecret(), audience: 'dooaa-oauth' });
    } catch {
      throw Errors.badRequest('That sign-in link has expired. Try again.', 'OAUTH_STATE_INVALID');
    }
    if (state.typ !== 'oauth-state' || state.p !== provider.id || !nonce || state.n !== nonce) {
      throw Errors.badRequest('That sign-in link has expired. Try again.', 'OAUTH_STATE_INVALID');
    }
    if (!query.code) throw Errors.badRequest('Sign-in was cancelled.', 'OAUTH_CANCELLED');

    let profile: OAuthProfile;
    try {
      profile = await provider.exchange({ code: query.code, redirectUri: this.redirectUri(provider.id) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn(`${provider.id} sign-in failed: ${(error as Error).message}`);
      throw Errors.badGateway(`We could not reach ${provider.id === 'google' ? 'Google' : 'Facebook'}. Try again.`, 'OAUTH_FAILED');
    }

    const { user, isNewUser } = await this.resolveUser(provider.id, profile);
    const code = randomBytes(32).toString('base64url');
    await this.db.insert(oauthGrants).values({
      codeHash: hashToken(code),
      userId: user.id,
      isNewUser,
      next: state.next,
      expiresAt: new Date(Date.now() + GRANT_TTL_MS),
    });
    return this.clientRedirect({ code });
  }

  /** Trades the one-time code for a session. A code works once, for two minutes. */
  async exchange(code: string, meta: SessionMeta): Promise<OAuthExchangeResult> {
    // Deleting the grant is the claim: a code works once even when two requests race.
    const [grant] = await this.db
      .delete(oauthGrants)
      .where(and(eq(oauthGrants.codeHash, hashToken(code)), gt(oauthGrants.expiresAt, new Date())))
      .returning();
    if (!grant) throw Errors.badRequest('That sign-in has expired. Try again.', 'OAUTH_CODE_INVALID');
    const user = await this.users.findById(grant.userId);
    if (!user) throw Errors.badRequest('That sign-in has expired. Try again.', 'OAUTH_CODE_INVALID');
    this.auth.assertCanSignIn(user);
    await this.users.recordSignIn(user.id);
    const tokens = await this.tokens.issue('user', user.id, user.tokenVersion, meta);
    return { user: toPublicUser(await this.users.getById(user.id)), tokens, isNewUser: grant.isNewUser, next: grant.next || null };
  }

  /**
   * Finds the account this provider identity belongs to, linking or
   * creating one by email when it is new. Linking needs an email the
   * provider has verified.
   */
  async resolveUser(provider: OAuthProviderId, profile: OAuthProfile): Promise<{ user: User; isNewUser: boolean }> {
    const [linkedRow] = await this.db
      .select(userColumns)
      .from(userOauthIdentities)
      .innerJoin(users, eq(users.id, userOauthIdentities.userId))
      .where(and(eq(userOauthIdentities.provider, provider), eq(userOauthIdentities.subject, profile.subject)));
    const linked = linkedRow ? toUser(linkedRow) : null;
    if (linked) {
      this.auth.assertCanSignIn(linked);
      return { user: linked, isNewUser: false };
    }

    if (!profile.email) {
      throw Errors.badRequest('Your account did not share an email address. Allow email access or sign up with email.', 'OAUTH_EMAIL_REQUIRED');
    }
    if (!profile.emailVerified) {
      throw Errors.badRequest('Confirm your email address with the provider first, or sign up with email.', 'OAUTH_EMAIL_UNVERIFIED');
    }
    const existing = await this.users.findByEmail(profile.email);
    if (existing) {
      this.auth.assertCanSignIn(existing);
      await this.link(existing.id, provider, profile);
      const user = existing.emailVerified
        ? existing
        : // Nobody ever proved they own this address; the provider just did. Whoever
          // registered it (possibly someone squatting it) loses the password and sessions.
          await this.users.update(existing.id, {
            emailVerified: true,
            passwordHash: await this.randomPasswordHash(),
            tokenVersion: sql`${users.tokenVersion} + 1`,
          });
      if (!existing.emailVerified) await this.tokens.revokeAll('user', existing.id);
      void this.mail.send(user.email, {
        subject: `${this.label(provider)} sign-in added to your DOOAA account`,
        heading: `${this.label(provider)} sign-in added`,
        paragraphs: [
          `Hi ${user.firstName}, you can now sign in to DOOAA with ${this.label(provider)}.`,
          'If this was not you, reset your password and contact support right away.',
        ],
      });
      return { user, isNewUser: false };
    }

    const local = profile.email.split('@')[0].replace(/[^a-zA-Z]+/g, ' ').trim();
    const created = await this.users.create({
      firstName: this.name(profile.firstName) || this.name(local) || 'DOOAA',
      lastName: this.name(profile.lastName) || 'User',
      email: profile.email,
      phone: '',
      passwordHash: await this.randomPasswordHash(),
    });
    await this.link(created.id, provider, profile);
    const user = await this.users.update(created.id, { emailVerified: true });
    void this.mail.send(user.email, {
      subject: 'Welcome to DOOAA',
      heading: `Welcome, ${user.firstName}!`,
      paragraphs: [
        `Your account is ready and you can sign in with ${this.label(provider)}.`,
        'To also sign in with a password, use "Forgot password" on the sign-in page to set one.',
      ],
      cta: { label: 'Start exploring', url: this.config.clientUrl },
    });
    return { user, isNewUser: true };
  }

  /** Records that this provider account signs in to the user. A repeat of the same link is a no-op. */
  private async link(userId: string, provider: OAuthProviderId, profile: OAuthProfile): Promise<void> {
    await this.db
      .insert(userOauthIdentities)
      .values({ userId, provider, subject: profile.subject, email: profile.email ?? null })
      .onConflictDoNothing({ target: [userOauthIdentities.provider, userOauthIdentities.subject] });
  }

  private label(provider: OAuthProviderId): string {
    return provider === 'google' ? 'Google' : 'Facebook';
  }

  private name(value: string | undefined): string {
    return (value ?? '').trim().slice(0, 60);
  }

  /** Accounts made through a provider have no usable password until the owner sets one. */
  private async randomPasswordHash(): Promise<string> {
    return this.passwords.hash(randomBytes(32).toString('base64url'));
  }
}
