import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CacheService } from '../../cache/cache.service';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
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
      const [row] = await this.db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          role: users.role,
          emailVerified: users.emailVerified,
          identity: users.identity,
          verificationLevel: users.verificationLevel,
          status: users.status,
          tokenVersion: users.tokenVersion,
        })
        .from(users)
        .where(eq(users.id, id));
      return row ? { kind: 'user', ...row } : null;
    });
  }

  staffMember(id: string): Promise<AuthStaff | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    return this.cache.wrap(`principal:staff:${id}`, PRINCIPAL_TTL_MS, async () => {
      const [row] = await this.db
        .select({
          id: staff.id,
          email: staff.email,
          firstName: staff.firstName,
          lastName: staff.lastName,
          role: staff.role,
          status: staff.status,
          tokenVersion: staff.tokenVersion,
        })
        .from(staff)
        .where(eq(staff.id, id));
      return row ? { kind: 'staff', ...row } : null;
    });
  }

  async invalidateUser(id: string): Promise<void> {
    await this.cache.delete(`principal:user:${id}`);
  }

  async invalidateStaff(id: string): Promise<void> {
    await this.cache.delete(`principal:staff:${id}`);
  }
}
