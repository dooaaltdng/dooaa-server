import { Injectable } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { Errors } from '../../common/api/app-error';
import type { AccountStatus, UserRole } from '../../common/domain';
import { looksLikeEmail, normalizeEmail, normalizePhone } from '../../common/util/text';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { users } from '../../database/schema';
import { isUniqueViolation } from '../../database/sql';
import { PrincipalService } from '../auth/principal.service';
import { TokenService } from '../auth/token.service';
import { toUser, userColumns, type User } from './user.model';

export type NewUser = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  passwordHash: string;
};

/** Column changes for `update`: plain values or SQL expressions such as increments. */
export type UserPatch = PgUpdateSetSource<typeof users>;

@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly principals: PrincipalService,
    private readonly tokens: TokenService,
  ) {}

  async findById(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    const [row] = await this.db.select(userColumns).from(users).where(eq(users.id, id));
    return row ? toUser(row) : null;
  }

  async findByIds(ids: string[]): Promise<User[]> {
    const valid = [...new Set(ids.filter(isUuid))];
    if (!valid.length) return [];
    const rows = await this.db.select(userColumns).from(users).where(inArray(users.id, valid));
    return rows.map(toUser);
  }

  async getById(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw Errors.notFound('We could not find that account.', 'USER_NOT_FOUND');
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select(userColumns).from(users).where(eq(users.email, normalizeEmail(email)));
    return row ? toUser(row) : null;
  }

  /** The account and its password hash, for checking a password. */
  async findByEmailWithPassword(email: string): Promise<(User & { passwordHash: string }) | null> {
    const [row] = await this.db
      .select({ ...userColumns, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row ? { ...toUser(row), passwordHash: row.passwordHash } : null;
  }

  async passwordHashOf(id: string): Promise<string | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, id));
    return row?.passwordHash;
  }

  /** An email address or a phone number, the way the forgot-password field accepts either. */
  async findByIdentifier(identifier: string): Promise<User | null> {
    const value = identifier.trim();
    if (!value) return null;
    if (looksLikeEmail(value)) return this.findByEmail(value);
    const phone = normalizePhone(value);
    if (!phone) return null;
    const [row] = await this.db.select(userColumns).from(users).where(eq(users.phone, phone)).orderBy(asc(users.createdAt)).limit(1);
    return row ? toUser(row) : null;
  }

  async create(input: NewUser): Promise<User> {
    const now = new Date();
    try {
      const [row] = await this.db
        .insert(users)
        .values({
          ...input,
          email: normalizeEmail(input.email),
          phone: normalizePhone(input.phone),
          termsAcceptedAt: now,
          privacyAcceptedAt: now,
        })
        .returning(userColumns);
      return toUser(row);
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        throw Errors.conflict('An account with that email already exists.', 'EMAIL_TAKEN');
      }
      throw error;
    }
  }

  async update(id: string, patch: UserPatch): Promise<User> {
    if (!isUuid(id)) throw Errors.notFound('We could not find that account.', 'USER_NOT_FOUND');
    const [row] = await this.db.update(users).set(patch).where(eq(users.id, id)).returning(userColumns);
    if (!row) throw Errors.notFound('We could not find that account.', 'USER_NOT_FOUND');
    await this.principals.invalidateUser(id);
    return toUser(row);
  }

  async setRole(id: string, role: UserRole): Promise<User> {
    return this.update(id, { role });
  }

  /** Replaces the password and ends every session minted under the old one. */
  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, failedSignIns: 0, lockedUntil: null, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, id));
    await this.principals.invalidateUser(id);
    await this.tokens.revokeAll('user', id);
  }

  /** Counts a failed sign-in and locks the account after too many in a row. Returns the lock expiry if locked. */
  async recordFailedSignIn(id: string, maxAttempts: number, lockMinutes: number): Promise<Date | null> {
    const [row] = await this.db
      .update(users)
      .set({ failedSignIns: sql`${users.failedSignIns} + 1` })
      .where(eq(users.id, id))
      .returning({ failedSignIns: users.failedSignIns });
    if (row && row.failedSignIns >= maxAttempts) {
      const lockedUntil = new Date(Date.now() + lockMinutes * 60_000);
      await this.db.update(users).set({ lockedUntil, failedSignIns: 0 }).where(eq(users.id, id));
      return lockedUntil;
    }
    return null;
  }

  async recordSignIn(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date(), failedSignIns: 0, lockedUntil: null }).where(eq(users.id, id));
  }

  /**
   * Console moderation and self-closing. Bans and closures end every session
   * at once; a suspended account keeps its sessions but the guard limits it
   * to its profile, sign-out and support.
   */
  async setStatus(id: string, status: AccountStatus, reason?: string): Promise<User> {
    const endSessions = status === 'banned' || status === 'closed';
    const user = await this.update(id, {
      status,
      statusReason: reason ?? null,
      ...(endSessions ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
    });
    if (endSessions) await this.tokens.revokeAll('user', id);
    return user;
  }

  async incrementStats(id: string, inc: Partial<Record<'purchases' | 'sales' | 'activeListings', number>>): Promise<void> {
    const patch: UserPatch = {};
    if (inc.purchases) patch.statsPurchases = sql`${users.statsPurchases} + ${inc.purchases}`;
    if (inc.sales) patch.statsSales = sql`${users.statsSales} + ${inc.sales}`;
    if (inc.activeListings) patch.statsActiveListings = sql`${users.statsActiveListings} + ${inc.activeListings}`;
    if (Object.keys(patch).length) await this.db.update(users).set(patch).where(eq(users.id, id));
  }

  async setStats(id: string, set: Partial<Record<'activeListings' | 'ratingAverage' | 'ratingCount', number>>): Promise<void> {
    const patch: UserPatch = {};
    if (set.activeListings !== undefined) patch.statsActiveListings = set.activeListings;
    if (set.ratingAverage !== undefined) patch.statsRatingAverage = set.ratingAverage;
    if (set.ratingCount !== undefined) patch.statsRatingCount = set.ratingCount;
    if (Object.keys(patch).length) await this.db.update(users).set(patch).where(eq(users.id, id));
  }

  async invalidate(id: string): Promise<void> {
    await this.principals.invalidateUser(id);
  }
}
