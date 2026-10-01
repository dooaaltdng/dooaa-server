import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import type { Lean } from '../../common/util/mongo';
import { AuditService } from '../audit/audit.service';
import type { CouponTerms } from '../orders/pricing';
import { Coupon } from './coupon.schema';

export type CouponInput = {
  code: string;
  description?: string;
  type: 'percent' | 'fixed';
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
    @InjectModel(Coupon.name) private readonly coupons: Model<Coupon>,
    private readonly audit: AuditService,
  ) {}

  /** The coupon behind a code if it can be used right now, else null. */
  async usable(code: string | null | undefined, now = new Date()): Promise<CouponTerms | null> {
    if (!code) return null;
    const coupon = await this.coupons.findOne({ code: code.trim().toUpperCase(), active: true }).lean<Lean<Coupon>>();
    if (!coupon) return null;
    if (coupon.startsAt && coupon.startsAt > now) return null;
    if (coupon.expiresAt && coupon.expiresAt < now) return null;
    if (coupon.maxRedemptions !== undefined && coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions) return null;
    return { code: coupon.code, type: coupon.type, value: coupon.value, maxDiscount: coupon.maxDiscount, minSubtotal: coupon.minSubtotal };
  }

  async require(code: string): Promise<CouponTerms> {
    const coupon = await this.usable(code);
    if (!coupon) throw Errors.badRequest("That coupon code isn't valid.", 'COUPON_INVALID');
    return coupon;
  }

  /** Counts a use once a payment that applied it succeeds. */
  async redeem(code: string): Promise<void> {
    await this.coupons.updateOne({ code: code.toUpperCase() }, { $inc: { redemptions: 1 } });
  }

  async list(): Promise<Lean<Coupon>[]> {
    return this.coupons.find().sort({ createdAt: -1 }).lean<Lean<Coupon>[]>();
  }

  async create(staff: AuthStaff, input: CouponInput): Promise<Lean<Coupon>> {
    if (input.type === 'percent' && input.value > 100) throw Errors.badRequest('A percentage coupon cannot exceed 100%.', 'VALIDATION_FAILED');
    try {
      const created = await this.coupons.create({ ...input, code: input.code.toUpperCase() });
      await this.audit.record(staff, { action: 'Created a coupon', target: created.code, targetType: 'coupon', targetId: String(created._id) });
      return created.toObject() as Lean<Coupon>;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw Errors.conflict('A coupon with that code already exists.', 'COUPON_EXISTS');
      throw error;
    }
  }

  async update(staff: AuthStaff, code: string, patch: Partial<CouponInput>): Promise<Lean<Coupon>> {
    const updated = await this.coupons.findOneAndUpdate({ code: code.toUpperCase() }, { $set: patch }, { returnDocument: 'after' }).lean<Lean<Coupon>>();
    if (!updated) throw Errors.notFound('That coupon does not exist.', 'COUPON_NOT_FOUND');
    await this.audit.record(staff, { action: 'Updated a coupon', target: updated.code, targetType: 'coupon', targetId: String(updated._id) });
    return updated;
  }

  /** The demo code the cart frame advertises. */
  async ensureDefaults(): Promise<void> {
    await this.coupons.updateOne(
      { code: 'DOOAA10' },
      { $setOnInsert: { code: 'DOOAA10', description: '10% off your cart', type: 'percent', value: 10, active: true, redemptions: 0 } },
      { upsert: true },
    );
  }
}
