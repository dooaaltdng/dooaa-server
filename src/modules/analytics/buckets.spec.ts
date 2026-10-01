import { buildBuckets, compactCount, fold, percentChange } from './buckets';

const now = new Date('2026-10-01T12:00:00Z'); // Thursday in Lagos

describe('analytics buckets', () => {
  it('builds seven daily buckets ending today, and the seven before', () => {
    const { current, previous } = buildBuckets('7d', now);
    expect(current).toHaveLength(7);
    expect(current.at(-1)).toMatchObject({ label: 'Thu', keys: ['2026-10-01'] });
    expect(current[0].keys).toEqual(['2026-09-25']);
    expect(previous.at(-1)!.keys).toEqual(['2026-09-24']);
  });

  it('labels 30-day buckets by day of month', () => {
    const { current } = buildBuckets('30d', now);
    expect(current).toHaveLength(30);
    expect(current.at(-1)!.label).toBe('1');
    expect(current[0].keys).toEqual(['2026-09-02']);
  });

  it('groups 90 days into thirteen weeks', () => {
    const { current, previous } = buildBuckets('90d', now);
    expect(current).toHaveLength(13);
    expect(current[0].label).toBe('W1');
    expect(current.every((bucket) => bucket.keys.length === 7)).toBe(true);
    expect(current.at(-1)!.keys.at(-1)).toBe('2026-10-01');
    expect(new Set([...current, ...previous].flatMap((bucket) => bucket.keys)).size).toBe(182);
  });

  it('builds twelve months against the twelve before', () => {
    const { current, previous, from } = buildBuckets('12m', now);
    expect(current.map((bucket) => bucket.label)).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    expect(current[0].keys).toEqual(['2025-11']);
    expect(previous.at(-1)!.keys).toEqual(['2025-10']);
    expect(from.toISOString()).toBe('2025-10-31T23:00:00.000Z');
  });

  it('folds values into buckets and computes change', () => {
    const { current } = buildBuckets('90d', now);
    const values = new Map([[current[0].keys[0], 10], [current[0].keys[6], 5.5], [current[3].keys[2], 1]]);
    expect(fold(current, values).slice(0, 4)).toEqual([15.5, 0, 0, 1]);
    expect(percentChange(105, 100)).toBe(5);
    expect(percentChange(5, 0)).toBe(100);
    expect(percentChange(0, 0)).toBe(0);
    expect(compactCount(250_000)).toBe('250k');
    expect(compactCount(1_200_000)).toBe('1.2M');
    expect(compactCount(950)).toBe('950');
  });
});
