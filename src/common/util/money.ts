/**
 * Money is stored and returned in Naira (major units) with at most two
 * decimals, but every calculation runs in integer kobo so sums, percentages
 * and splits never drift. Providers that take minor units (Paystack) get
 * `toKobo` at the boundary.
 */

export function toKobo(naira: number): number {
  return Math.round((naira + Number.EPSILON) * 100);
}

export function fromKobo(kobo: number): number {
  return Math.round(kobo) / 100;
}

export function roundMoney(naira: number): number {
  return fromKobo(toKobo(naira));
}

export function sumMoney(...values: number[]): number {
  return fromKobo(values.reduce((total, value) => total + toKobo(value), 0));
}

export function subtractMoney(from: number, ...values: number[]): number {
  return fromKobo(values.reduce((total, value) => total - toKobo(value), toKobo(from)));
}

export function multiplyMoney(amount: number, factor: number): number {
  return fromKobo(Math.round(toKobo(amount) * factor));
}

/** `percent` is a percentage (0.5 means half a percent). */
export function percentOf(amount: number, percent: number): number {
  return fromKobo(Math.round((toKobo(amount) * percent) / 100));
}

/**
 * Splits `total` across `weights` proportionally, exactly: the parts always
 * add back up to `total`, with rounding remainders given to the largest
 * weights first.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const totalKobo = toKobo(total);
  const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (weightSum === 0) {
    const even = Math.floor(totalKobo / weights.length);
    const parts = weights.map(() => even);
    let remainder = totalKobo - even * weights.length;
    for (let index = 0; remainder > 0; index = (index + 1) % parts.length, remainder -= 1) parts[index] += 1;
    return parts.map(fromKobo);
  }
  const exact = weights.map((weight) => (totalKobo * Math.max(0, weight)) / weightSum);
  const parts = exact.map(Math.floor);
  let remainder = totalKobo - parts.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value), weight: weights[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight);
  for (let cursor = 0; remainder > 0; cursor = (cursor + 1) % order.length, remainder -= 1) {
    parts[order[cursor].index] += 1;
  }
  return parts.map(fromKobo);
}

/** "₦1,230,740" — used in emails, notifications and system lines. */
export function formatNaira(amount: number): string {
  const hasKobo = toKobo(amount) % 100 !== 0;
  const formatted = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: hasKobo ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
  return `₦${formatted}`;
}

/** "₦1.2M", "₦284k" — the compact form the admin trend headlines use. */
export function formatNairaCompact(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, '');
  if (abs >= 1_000_000_000) return `${sign}₦${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}₦${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}₦${trim(abs / 1_000)}k`;
  return `${sign}₦${trim(abs)}`;
}
