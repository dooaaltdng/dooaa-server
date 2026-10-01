import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { TtlCache } from '../../common/util/cache';
import { Staff } from '../staff/schemas/staff.schema';
import { User } from '../users/schemas/user.schema';

/**
 * Loads the account behind a token. Cached for a few seconds so a burst of
 * requests costs one read; anything that changes status or role calls
 * `invalidate*` so this instance sees it at once.
 */
@Injectable()
export class PrincipalService {
  private readonly users = new TtlCache<AuthUser | null>(5_000);
  private readonly staff = new TtlCache<AuthStaff | null>(5_000);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Staff.name) private readonly staffModel: Model<Staff>,
  ) {}

  user(id: string): Promise<AuthUser | null> {
    return this.users.wrap(id, async () => {
      const row = await this.userModel
        .findById(id)
        .select('email firstName lastName phone role emailVerified identity verificationLevel status tokenVersion')
        .lean();
      if (!row) return null;
      return {
        kind: 'user',
        id: String(row._id),
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone ?? '',
        role: row.role ?? null,
        emailVerified: row.emailVerified,
        identity: row.identity,
        verificationLevel: row.verificationLevel,
        status: row.status,
        tokenVersion: row.tokenVersion ?? 0,
      };
    });
  }

  staffMember(id: string): Promise<AuthStaff | null> {
    return this.staff.wrap(id, async () => {
      const row = await this.staffModel.findById(id).select('email firstName lastName role status tokenVersion').lean();
      if (!row) return null;
      return {
        kind: 'staff',
        id: String(row._id),
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        role: row.role,
        status: row.status,
        tokenVersion: row.tokenVersion ?? 0,
      };
    });
  }

  invalidateUser(id: string): void {
    this.users.delete(id);
  }

  invalidateStaff(id: string): void {
    this.staff.delete(id);
  }
}
