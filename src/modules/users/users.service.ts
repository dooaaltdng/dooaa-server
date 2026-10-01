import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, UpdateQuery } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AccountStatus, UserRole } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import { looksLikeEmail, normalizeEmail, normalizePhone } from '../../common/util/text';
import { PrincipalService } from '../auth/principal.service';
import { TokenService } from '../auth/token.service';
import { User } from './schemas/user.schema';

export type NewUser = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  passwordHash: string;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly principals: PrincipalService,
    private readonly tokens: TokenService,
  ) {}

  get model(): Model<User> {
    return this.users;
  }

  async findById(id: string | Types.ObjectId): Promise<Lean<User> | null> {
    if (!Types.ObjectId.isValid(String(id))) return null;
    return this.users.findById(id).lean<Lean<User>>();
  }

  async getById(id: string | Types.ObjectId): Promise<Lean<User>> {
    const user = await this.findById(id);
    if (!user) throw Errors.notFound('We could not find that account.', 'USER_NOT_FOUND');
    return user;
  }

  async findByEmail(email: string, withPassword = false): Promise<Lean<User> | null> {
    const query = this.users.findOne({ email: normalizeEmail(email) });
    if (withPassword) query.select('+passwordHash');
    return query.lean<Lean<User>>();
  }

  /** An email address or a phone number, the way the forgot-password field accepts either. */
  async findByIdentifier(identifier: string): Promise<Lean<User> | null> {
    const value = identifier.trim();
    if (!value) return null;
    if (looksLikeEmail(value)) return this.findByEmail(value);
    const phone = normalizePhone(value);
    if (!phone) return null;
    return this.users.findOne({ phone }).sort({ createdAt: 1 }).lean<Lean<User>>();
  }

  async create(input: NewUser): Promise<Lean<User>> {
    try {
      const now = new Date();
      const created = await this.users.create({
        ...input,
        email: normalizeEmail(input.email),
        phone: normalizePhone(input.phone),
        termsAcceptedAt: now,
        privacyAcceptedAt: now,
      });
      return created.toObject() as Lean<User>;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw Errors.conflict('An account with that email already exists.', 'EMAIL_TAKEN');
      }
      throw error;
    }
  }

  async update(id: string, update: UpdateQuery<User>): Promise<Lean<User>> {
    const user = await this.users
      .findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true })
      .lean<Lean<User>>();
    if (!user) throw Errors.notFound('We could not find that account.', 'USER_NOT_FOUND');
    this.principals.invalidateUser(id);
    return user;
  }

  async setRole(id: string, role: UserRole): Promise<Lean<User>> {
    return this.update(id, { $set: { role } });
  }

  /** Replaces the password and ends every session minted under the old one. */
  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.users.updateOne(
      { _id: id },
      { $set: { passwordHash, failedSignIns: 0 }, $unset: { lockedUntil: 1 }, $inc: { tokenVersion: 1 } },
    );
    this.principals.invalidateUser(id);
    await this.tokens.revokeAll('user', id);
  }

  /** Counts a failed sign-in and locks the account after too many in a row. Returns the lock expiry if locked. */
  async recordFailedSignIn(id: string, maxAttempts: number, lockMinutes: number): Promise<Date | null> {
    const user = await this.users.findByIdAndUpdate(id, { $inc: { failedSignIns: 1 } }, { returnDocument: 'after' }).lean();
    if (user && user.failedSignIns >= maxAttempts) {
      const lockedUntil = new Date(Date.now() + lockMinutes * 60_000);
      await this.users.updateOne({ _id: id }, { $set: { lockedUntil, failedSignIns: 0 } });
      return lockedUntil;
    }
    return null;
  }

  async recordSignIn(id: string): Promise<void> {
    await this.users.updateOne(
      { _id: id },
      { $set: { lastLoginAt: new Date(), failedSignIns: 0 }, $unset: { lockedUntil: 1 } },
    );
  }

  /**
   * Console moderation and self-closing. Bans and closures end every session
   * at once; a suspended account keeps its sessions but the guard limits it
   * to its profile, sign-out and support.
   */
  async setStatus(id: string, status: AccountStatus, reason?: string): Promise<Lean<User>> {
    const endSessions = status === 'banned' || status === 'closed';
    const user = await this.update(id, {
      $set: { status, statusReason: reason },
      ...(endSessions ? { $inc: { tokenVersion: 1 } } : {}),
    });
    if (endSessions) await this.tokens.revokeAll('user', id);
    return user;
  }

  async incrementStats(id: string | Types.ObjectId, inc: Partial<Record<'purchases' | 'sales' | 'activeListings', number>>): Promise<void> {
    const update: Record<string, number> = {};
    for (const [key, value] of Object.entries(inc)) if (value) update[`stats.${key}`] = value;
    if (Object.keys(update).length) await this.users.updateOne({ _id: id }, { $inc: update });
  }

  async setStats(id: string | Types.ObjectId, set: Partial<Record<'activeListings' | 'ratingAverage' | 'ratingCount', number>>): Promise<void> {
    const update: Record<string, number> = {};
    for (const [key, value] of Object.entries(set)) if (value !== undefined) update[`stats.${key}`] = value;
    if (Object.keys(update).length) await this.users.updateOne({ _id: id }, { $set: update });
  }

  invalidate(id: string): void {
    this.principals.invalidateUser(id);
  }
}
