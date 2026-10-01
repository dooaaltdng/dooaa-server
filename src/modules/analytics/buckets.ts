import { DAY, dayKey } from '../../common/util/dates';

export type RangeId = '7d' | '30d' | '90d' | '12m';

export type Bucket = {
  /** Axis label: "Mon", "23", "W3", "Jan". */
  label: string;
  /** Tooltip label. */
  date: string;
  /** The Lagos day keys (or month keys) this bucket covers. */
  keys: string[];
};

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Africa/Lagos' });
const DAY_NUMBER = new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'Africa/Lagos' });
const LONG = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'Africa/Lagos' });
const MONTH_LONG = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' });

function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * The current period's buckets and the previous period's, aligned so
 * `current[i]` and `previous[i]` are compared on the chart.
 */
export function buildBuckets(range: RangeId, now: Date = new Date()): { current: Bucket[]; previous: Bucket[]; from: Date; previousFrom: Date; to: Date } {
  const to = new Date(now.getTime());
  if (range === '12m') {
    const [year, month] = dayKey(now).split('-').map(Number);
    const months = (offset: number) =>
      Array.from({ length: 12 }, (_, index) => {
        const absolute = (year * 12 + (month - 1)) - (11 - index) - offset;
        const y = Math.floor(absolute / 12);
        const m = absolute % 12;
        const sample = new Date(Date.UTC(y, m, 15, 12));
        return { label: MONTH.format(sample), date: MONTH_LONG.format(sample), keys: [monthKeyOf(y, m)] };
      });
    const current = months(0);
    const previous = months(12);
    const [fy, fm] = current[0].keys[0].split('-').map(Number);
    const [py, pm] = previous[0].keys[0].split('-').map(Number);
    return { current, previous, from: new Date(`${monthKeyOf(fy, fm - 1)}-01T00:00:00+01:00`), previousFrom: new Date(`${monthKeyOf(py, pm - 1)}-01T00:00:00+01:00`), to };
  }

  const days = range === '7d' ? 7 : range === '30d' ? 30 : 91;
  const dayAt = (offset: number) => new Date(now.getTime() - offset * DAY);
  const daily = (shift: number): Bucket[] =>
    Array.from({ length: days }, (_, index) => {
      const date = dayAt(days - 1 - index + shift);
      return { label: range === '7d' ? WEEKDAY.format(date) : DAY_NUMBER.format(date), date: LONG.format(date), keys: [dayKey(date)] };
    });

  if (range === '90d') {
    const weekly = (shift: number): Bucket[] =>
      Array.from({ length: 13 }, (_, week) => {
        const keys = Array.from({ length: 7 }, (_, d) => dayKey(dayAt(days - 1 - (week * 7 + d) + shift)));
        return { label: `W${week + 1}`, date: `Week of ${LONG.format(dayAt(days - 1 - week * 7 + shift))}`, keys };
      });
    return { current: weekly(0), previous: weekly(days), from: new Date(`${dayKey(dayAt(days - 1))}T00:00:00+01:00`), previousFrom: new Date(`${dayKey(dayAt(2 * days - 1))}T00:00:00+01:00`), to };
  }

  return { current: daily(0), previous: daily(days), from: new Date(`${dayKey(dayAt(days - 1))}T00:00:00+01:00`), previousFrom: new Date(`${dayKey(dayAt(2 * days - 1))}T00:00:00+01:00`), to };
}

/** Sums per-key values into buckets. */
export function fold(buckets: Bucket[], values: Map<string, number>): number[] {
  return buckets.map((bucket) => Math.round(bucket.keys.reduce((sum, key) => sum + (values.get(key) ?? 0), 0) * 100) / 100);
}

export function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function compactCount(value: number): string {
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}
