import { couponDiscount, escrowFeeFor, groupsReconcile, priceCart, priceEscrow, type PricingSettings } from './pricing';

const SETTINGS: PricingSettings = {
  deliveryFee: 5_000,
  escrowDeliveryFee: 5_000,
  taxRate: 0,
  escrowFeePercent: 0.5,
  escrowMinimumFee: 500,
  commissionPercent: 0,
};

describe('pricing', () => {
  it('splits a cart into one order per seller, each with its courier fee', () => {
    const pricing = priceCart(
      [
        { productId: 'p1', sellerId: 'A', unitPrice: 400_000, quantity: 1 },
        { productId: 'p2', sellerId: 'B', unitPrice: 720_000, quantity: 2 },
        { productId: 'p3', sellerId: 'A', unitPrice: 15_000, quantity: 3 },
      ],
      null,
      SETTINGS,
    );
    expect(pricing.groups.map((group) => group.sellerId)).toEqual(['A', 'B']);
    expect(pricing.groups[0]).toMatchObject({ subtotal: 445_000, shipping: 5_000, total: 450_000, sellerEarning: 450_000 });
    expect(pricing.groups[1]).toMatchObject({ subtotal: 1_440_000, total: 1_445_000 });
    expect(pricing).toMatchObject({ count: 6, subtotal: 1_885_000, delivery: 10_000, discount: 0, total: 1_895_000, coupon: null });
    expect(groupsReconcile(pricing)).toBe(true);
  });

  it('spreads a coupon across orders exactly, at DOOAA’s expense', () => {
    const coupon = { code: 'DOOAA10', type: 'percent' as const, value: 10 };
    const pricing = priceCart(
      [
        { productId: 'p1', sellerId: 'A', unitPrice: 333.33, quantity: 1 },
        { productId: 'p2', sellerId: 'B', unitPrice: 333.33, quantity: 1 },
        { productId: 'p3', sellerId: 'C', unitPrice: 333.34, quantity: 1 },
      ],
      coupon,
      { ...SETTINGS, deliveryFee: 0 },
    );
    expect(pricing.discount).toBe(100);
    expect(pricing.groups.reduce((sum, group) => sum + Math.round(group.discount * 100), 0)).toBe(10_000);
    expect(pricing.total).toBe(900);
    expect(pricing.coupon).toBe('DOOAA10');
    // Sellers are paid on the undiscounted subtotal.
    expect(pricing.groups.map((group) => group.sellerEarning)).toEqual([333.33, 333.33, 333.34]);
    expect(groupsReconcile(pricing)).toBe(true);
  });

  it('applies coupon rules: minimum subtotal, cap and fixed amounts', () => {
    expect(couponDiscount({ code: 'X', type: 'percent', value: 10, minSubtotal: 50_000 }, 40_000)).toBe(0);
    expect(couponDiscount({ code: 'X', type: 'percent', value: 50, maxDiscount: 20_000 }, 100_000)).toBe(20_000);
    expect(couponDiscount({ code: 'X', type: 'fixed', value: 5_000 }, 3_000)).toBe(3_000);
    expect(couponDiscount(null, 3_000)).toBe(0);
  });

  it('charges VAT on the discounted subtotal when enabled', () => {
    const pricing = priceCart([{ productId: 'p1', sellerId: 'A', unitPrice: 100_000, quantity: 1 }], { code: 'TEN', type: 'fixed', value: 10_000 }, { ...SETTINGS, taxRate: 7.5 });
    expect(pricing.groups[0]).toMatchObject({ subtotal: 100_000, discount: 10_000, tax: 6_750, shipping: 5_000, total: 101_750 });
    expect(groupsReconcile(pricing)).toBe(true);
  });

  it('takes commission from the seller’s earning, not the buyer’s total', () => {
    const pricing = priceCart([{ productId: 'p1', sellerId: 'A', unitPrice: 200_000, quantity: 1 }], null, { ...SETTINGS, commissionPercent: 2.5 });
    expect(pricing.groups[0]).toMatchObject({ total: 205_000, commission: 5_000, sellerEarning: 200_000 });
  });

  it('prices Buy-via-Escrow with the escrow fee and its floor', () => {
    expect(priceEscrow(400_000, 1, SETTINGS)).toMatchObject({ subtotal: 400_000, deliveryFee: 5_000, escrowFee: 2_000, total: 407_000, sellerEarning: 405_000 });
    expect(priceEscrow(20_000, 1, SETTINGS).escrowFee).toBe(500);
    expect(priceEscrow(1_789_000, 2, SETTINGS)).toMatchObject({ subtotal: 3_578_000, escrowFee: 17_890, total: 3_600_890 });
    expect(escrowFeeFor(0, SETTINGS)).toBe(0);
  });

  it('ignores empty lines and returns zeros for an empty cart', () => {
    expect(priceCart([{ productId: 'p', sellerId: 'A', unitPrice: 10, quantity: 0 }], null, SETTINGS)).toMatchObject({ groups: [], total: 0, delivery: 0, count: 0 });
  });
});
