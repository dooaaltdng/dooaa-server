import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, count, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { Errors } from '../../common/api/app-error';
import type { AccessTokenPayload } from '../../common/auth/principal';
import type { SubjectType } from '../../common/domain';
import { isUuid } from '../../common/util/uuid';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { sessions } from '../../database/schema';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshExpiresAt: string;
};

export type SessionMeta = { ip?: string; userAgent?: string };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectDb() private readonly db: Database,
  ) {}

  private secretFor(type: SubjectType): string {
    return type === 'staff' ? this.config.jwt.staffSecret : this.config.jwt.accessSecret;
  }

  private accessTtl(type: SubjectType): number {
    return type === 'staff' ? this.config.jwt.staffAccessTtl : this.config.jwt.accessTtl;
  }

  async signAccess(type: SubjectType, subjectId: string, version: number): Promise<string> {
    const payload: AccessTokenPayload = { sub: subjectId, typ: type, ver: version };
    return this.jwt.signAsync(payload, {
      secret: this.secretFor(type),
      expiresIn: this.accessTtl(type),
      issuer: 'dooaa',
      audience: type === 'staff' ? 'dooaa-admin' : 'dooaa-client',
    });
  }

  /** Verifies an access token of the given kind. Throws a 401 with a code the apps can act on. */
  async verifyAccess(type: SubjectType, token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.secretFor(type),
        issuer: 'dooaa',
        audience: type === 'staff' ? 'dooaa-admin' : 'dooaa-client',
      });
      if (payload.typ !== type || !isUuid(payload.sub)) throw new Error('wrong token type');
      return payload;
    } catch (error) {
      const expired = (error as { name?: string }).name === 'TokenExpiredError';
      throw expired
        ? Errors.unauthorized('Your session has expired. Sign in again.', 'TOKEN_EXPIRED')
        : Errors.unauthorized('Sign in to continue.', 'INVALID_TOKEN');
    }
  }

  async issue(type: SubjectType, subjectId: string, version: number, meta: SessionMeta = {}, family?: string): Promise<TokenPair> {
    const refreshToken = `${type === 'staff' ? 's' : 'u'}.${randomBytes(48).toString('base64url')}`;
    const days = type === 'staff' ? this.config.jwt.staffRefreshTtlDays : this.config.jwt.refreshTtlDays;
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await this.db.insert(sessions).values({
      subjectId,
      subjectType: type,
      tokenHash: hashToken(refreshToken),
      family: family ?? randomBytes(12).toString('hex'),
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return {
      accessToken: await this.signAccess(type, subjectId, version),
      refreshToken,
      expiresIn: this.accessTtl(type),
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Swaps a refresh token for a new pair. A token that was already rotated
   * coming back means it leaked: the whole sign-in is revoked.
   */
  async rotate(type: SubjectType, refreshToken: string, meta: SessionMeta = {}): Promise<{ subjectId: string; family: string }> {
    const tokenHash = hashToken(refreshToken);
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.subjectType, type)));
    if (!session) throw Errors.unauthorized('Sign in again to continue.', 'INVALID_REFRESH_TOKEN');
    if (session.revokedAt) {
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.family, session.family), isNull(sessions.revokedAt)));
      throw Errors.unauthorized('Sign in again to continue.', 'REFRESH_TOKEN_REUSED');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw Errors.unauthorized('Your session has expired. Sign in again.', 'REFRESH_TOKEN_EXPIRED');
    }
    // Conditional update: two concurrent refreshes with one token cannot both win.
    const now = new Date();
    const claimed = await this.db
      .update(sessions)
      .set({ revokedAt: now, replacedAt: now, ip: meta.ip ?? session.ip })
      .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!claimed.length) throw Errors.unauthorized('Sign in again to continue.', 'REFRESH_TOKEN_REUSED');
    return { subjectId: session.subjectId, family: session.family };
  }

  async revoke(type: SubjectType, refreshToken: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenHash, hashToken(refreshToken)), eq(sessions.subjectType, type), isNull(sessions.revokedAt)));
  }

  async revokeAll(type: SubjectType, subjectId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.subjectId, subjectId), eq(sessions.subjectType, type), isNull(sessions.revokedAt)));
  }

  async activeSessionCount(type: SubjectType, subjectId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(sessions)
      .where(and(eq(sessions.subjectId, subjectId), eq(sessions.subjectType, type), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
    return row.total;
  }
}
