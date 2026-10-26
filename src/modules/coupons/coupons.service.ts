import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import type { CouponType } from '../../common/domain';
import { InjectDb, isUniqueViolation, type Database } from '../../database/database';
import { coupons } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import type { CouponTerms } from '../orders/pricing';

export type Coupon = typeof coupons.$inferSelect;

export type CouponInput = {
  code: string;
  description?: string;
  type: CouponType;
  value: number;
  maxDiscount?: number;
  minSubtotal?: number;
  active?: boolean;
  startsAt?: Date;
  expiresAt?: Date;
  maxRedemptions?: number;
};

@Injectable()
export class CouponsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** The coupon behind a code if it can be used right now, else null. */
  async usable(code: string | null | undefined, now = new Date()): Promise<CouponTerms | null> {
    if (!code) return null;
    const coupon = await this.db.findOne(coupons, { code: code.trim().toUpperCase(), active: true });
    if (!coupon) return null;
    if (coupon.startsAt && coupon.startsAt > now) return null;
    if (coupon.expiresAt && coupon.expiresAt < now) return null;
    if (coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions) return null;
    return {
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      maxDiscount: coupon.maxDiscount ?? undefined,
      minSubtotal: coupon.minSubtotal ?? undefined,
    };
  }

  async require(code: string): Promise<CouponTerms> {
    const coupon = await this.usable(code);
    if (!coupon) throw Errors.badRequest("That coupon code isn't valid.", 'COUPON_INVALID');
    return coupon;
  }

  /** Counts a use once a payment that applied it succeeds. */
  async redeem(code: string): Promise<void> {
    await this.db.update(coupons, { code: code.toUpperCase() }, { $inc: { redemptions: 1 } });
  }

  async list(): Promise<Coupon[]> {
    return this.db.find(coupons, {}, { sort: { createdAt: -1 } });
  }

  async create(staff: AuthStaff, input: CouponInput): Promise<Coupon> {
    if (input.type === 'percent' && input.value > 100) throw Errors.badRequest('A percentage coupon cannot exceed 100%.', 'VALIDATION_FAILED');
    try {
      const created = await this.db.insert(coupons, { ...input, code: input.code.toUpperCase() });
      await this.audit.record(staff, { action: 'Created a coupon', target: created.code, targetType: 'coupon', targetId: created.id });
      return created;
    } catch (error) {
      if (isUniqueViolation(error, 'coupons_code_key')) throw Errors.conflict('A coupon with that code already exists.', 'COUPON_EXISTS');
      throw error;
    }
  }

  async update(staff: AuthStaff, code: string, patch: Partial<CouponInput>): Promise<Coupon> {
    const { code: _ignored, ...changes } = patch;
    const updated = Object.keys(changes).length
      ? await this.db.update(coupons, { code: code.toUpperCase() }, changes)
      : await this.db.findOne(coupons, { code: code.toUpperCase() });
    if (!updated) throw Errors.notFound('That coupon does not exist.', 'COUPON_NOT_FOUND');
    await this.audit.record(staff, { action: 'Updated a coupon', target: updated.code, targetType: 'coupon', targetId: updated.id });
    return updated;
  }

  /** The demo code the cart frame advertises. */
  async ensureDefaults(): Promise<void> {
    await this.db.insertIgnoringDuplicates(coupons, [{ code: 'DOOAA10', description: '10% off your cart', type: 'percent', value: 10, active: true }]);
  }
}
