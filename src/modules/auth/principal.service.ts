import { Injectable } from '@nestjs/common';
import { CacheService } from '../../cache/cache.service';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, pick, type Database } from '../../database/database';
import { staff, users } from '../../database/schema';

/** Long enough to absorb a burst of requests, short enough that a missed invalidation heals quickly. */
const PRINCIPAL_TTL_MS = 5_000;

/**
 * Loads the account behind a token. Cached in Redis for a few seconds so a
 * burst of requests costs one read; anything that changes status, role or
 * token version calls `invalidate*`, which every instance sees at once.
 */
@Injectable()
export class PrincipalService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly cache: CacheService,
  ) {}

  user(id: string): Promise<AuthUser | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.cache.wrap(`principal:user:${id}`, PRINCIPAL_TTL_MS, async () => {
      const row = await this.db.findOne(users, { id });
      return row
        ? {
            kind: 'user',
            ...pick(row, ['id', 'email', 'firstName', 'lastName', 'phone', 'role', 'emailVerified', 'identity', 'verificationLevel', 'status', 'tokenVersion']),
          }
        : null;
    });
  }

  staffMember(id: string): Promise<AuthStaff | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.cache.wrap(`principal:staff:${id}`, PRINCIPAL_TTL_MS, async () => {
      const row = await this.db.findOne(staff, { id });
      return row ? { kind: 'staff', ...pick(row, ['id', 'email', 'firstName', 'lastName', 'role', 'status', 'tokenVersion']) } : null;
    });
  }

  async invalidateUser(id: string): Promise<void> {
    await this.cache.delete(`principal:user:${id}`);
  }

  async invalidateStaff(id: string): Promise<void> {
    await this.cache.delete(`principal:staff:${id}`);
  }
}
