import { allocate, percentOf, subtractMoney, sumMoney, toKobo, multiplyMoney } from '../../common/util/money';

/**
 * Checkout arithmetic, kept pure so the cart page, the escrow quote and the
 * orders it creates always agree to the kobo.
 *
 * - A cart splits into one order per seller; each carries its own courier fee.
 * - A platform coupon discounts the whole cart and is spread across the
 *   orders in proportion to their subtotals. DOOAA absorbs it: sellers are
 *   paid on the undiscounted subtotal.
 * - Tax (VAT, off by default) applies to each order's discounted subtotal.
 * - Buy-via-Escrow adds the buyer-paid escrow fee.
 * - A seller's earning is subtotal + courier fee − DOOAA's commission.
 */

export type PricingSettings = {
  deliveryFee: number;
  escrowDeliveryFee: number;
  taxRate: number;
  escrowFeePercent: number;
  escrowMinimumFee: number;
  commissionPercent: number;
};

export type CouponTerms = { code: string; type: 'percent' | 'fixed'; value: number; maxDiscount?: number | null; minSubtotal?: number | null };

export type PricingLine = { productId: string; sellerId: string; unitPrice: number; quantity: number };

export type PricedGroup = {
  sellerId: string;
  lines: (PricingLine & { lineTotal: number })[];
  subtotal: number;
  discount: number;
  shipping: number;
  taxRate: number;
  tax: number;
  escrowFee: number;
  total: number;
  commission: number;
  sellerEarning: number;
};

export type CartPricing = {
  groups: PricedGroup[];
  count: number;
  subtotal: number;
  discount: number;
  delivery: number;
  tax: number;
  total: number;
  coupon: string | null;
};

export function couponDiscount(coupon: CouponTerms | null, subtotal: number): number {
  if (!coupon || subtotal <= 0) return 0;
  if (coupon.minSubtotal && subtotal < coupon.minSubtotal) return 0;
  let discount = coupon.type === 'percent' ? percentOf(subtotal, coupon.value) : coupon.value;
  if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  return Math.min(discount, subtotal);
}

export function escrowFeeFor(itemSubtotal: number, settings: Pick<PricingSettings, 'escrowFeePercent' | 'escrowMinimumFee'>): number {
  if (itemSubtotal <= 0) return 0;
  return Math.max(settings.escrowMinimumFee, percentOf(itemSubtotal, settings.escrowFeePercent));
}

function finishGroup(
  sellerId: string,
  lines: (PricingLine & { lineTotal: number })[],
  input: { discount: number; shipping: number; escrowFee: number; taxRate: number; commissionPercent: number },
): PricedGroup {
  const subtotal = sumMoney(...lines.map((line) => line.lineTotal));
  const taxable = subtractMoney(subtotal, input.discount);
  const tax = input.taxRate > 0 ? percentOf(taxable, input.taxRate) : 0;
  const commission = input.commissionPercent > 0 ? percentOf(subtotal, input.commissionPercent) : 0;
  return {
    sellerId,
    lines,
    subtotal,
    discount: input.discount,
    shipping: input.shipping,
    taxRate: input.taxRate,
    tax,
    escrowFee: input.escrowFee,
    total: sumMoney(taxable, tax, input.shipping, input.escrowFee),
    commission,
    sellerEarning: subtractMoney(sumMoney(subtotal, input.shipping), commission),
  };
}

/** Prices a cart: one group (order) per seller, in first-seen order. */
export function priceCart(lines: PricingLine[], coupon: CouponTerms | null, settings: PricingSettings): CartPricing {
  const bySeller = new Map<string, (PricingLine & { lineTotal: number })[]>();
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const list = bySeller.get(line.sellerId) ?? [];
    list.push({ ...line, lineTotal: multiplyMoney(line.unitPrice, line.quantity) });
    bySeller.set(line.sellerId, list);
  }
  const sellers = [...bySeller.keys()];
  const subtotals = sellers.map((seller) => sumMoney(...bySeller.get(seller)!.map((line) => line.lineTotal)));
  const subtotal = sumMoney(...subtotals);
  const discount = couponDiscount(coupon, subtotal);
  const shares = allocate(discount, subtotals);

  const groups = sellers.map((seller, index) =>
    finishGroup(seller, bySeller.get(seller)!, {
      discount: shares[index] ?? 0,
      shipping: settings.deliveryFee,
      escrowFee: 0,
      taxRate: settings.taxRate,
      commissionPercent: settings.commissionPercent,
    }),
  );

  return {
    groups,
    count: lines.reduce((sum, line) => sum + Math.max(0, line.quantity), 0),
    subtotal,
    discount,
    delivery: sumMoney(...groups.map((group) => group.shipping)),
    tax: sumMoney(...groups.map((group) => group.tax)),
    total: sumMoney(...groups.map((group) => group.total)),
    coupon: discount > 0 && coupon ? coupon.code : null,
  };
}

export type EscrowQuote = {
  itemPrice: number;
  quantity: number;
  subtotal: number;
  deliveryFee: number;
  escrowFee: number;
  taxRate: number;
  tax: number;
  total: number;
  commission: number;
  sellerEarning: number;
};

/** "Buy Now via Escrow": one item, a courier fee and DOOAA's escrow fee. */
export function priceEscrow(itemPrice: number, quantity: number, settings: PricingSettings): EscrowQuote {
  const lineTotal = multiplyMoney(itemPrice, quantity);
  const group = finishGroup('seller', [{ productId: 'item', sellerId: 'seller', unitPrice: itemPrice, quantity, lineTotal }], {
    discount: 0,
    shipping: settings.escrowDeliveryFee,
    escrowFee: escrowFeeFor(lineTotal, settings),
    taxRate: settings.taxRate,
    commissionPercent: settings.commissionPercent,
  });
  return {
    itemPrice,
    quantity,
    subtotal: group.subtotal,
    deliveryFee: group.shipping,
    escrowFee: group.escrowFee,
    taxRate: group.taxRate,
    tax: group.tax,
    total: group.total,
    commission: group.commission,
    sellerEarning: group.sellerEarning,
  };
}

/** Sanity check used by tests and checkout: kobo-exact totals. */
export function groupsReconcile(pricing: CartPricing): boolean {
  return toKobo(pricing.total) === toKobo(sumMoney(pricing.subtotal, -pricing.discount, pricing.delivery, pricing.tax));
}
