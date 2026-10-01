import { addDays, clockTime, clockTimeUpper, dayKey, longDate, monthKey, ordinal, ordinalDate, secondsUntil, shortStamp, startOfLagosDay, tenureLabel, yearsSince } from './dates';

describe('dates (Lagos time)', () => {
  it('keys days in Lagos, not UTC', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    expect(dayKey('2025-10-23T23:30:00Z')).toBe('2025-10-24');
    expect(dayKey('2025-10-23T22:59:00Z')).toBe('2025-10-23');
    expect(monthKey('2025-12-31T23:30:00Z')).toBe('2026-01');
  });

  it('prints the caption clock the threads use', () => {
    expect(clockTime('2025-10-23T15:15:00Z')).toBe('04:15pm');
    expect(clockTime('2025-10-23T08:05:00Z')).toBe('09:05am');
    expect(clockTime('2025-10-23T11:00:00Z')).toBe('12:00pm');
    expect(clockTimeUpper('2025-10-23T09:30:00Z')).toBe('10:30 AM');
  });

  it('prints long and ordinal dates', () => {
    expect(longDate('2025-10-23T09:00:00Z')).toBe('Oct 23, 2025');
    expect(ordinalDate('2025-06-23T09:00:00Z')).toBe('June 23rd, 2025');
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '111th'].join()).toBe(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 111].map(ordinal).join(),
    );
    expect(shortStamp('2025-10-25T10:45:00Z')).toBe('Oct 25, 11:45 AM');
  });

  it('finds the start of the Lagos day', () => {
    expect(startOfLagosDay('2025-10-23T15:00:00Z').toISOString()).toBe('2025-10-22T23:00:00.000Z');
  });

  it('counts seconds down to a deadline, floored at zero', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(secondsUntil(addDays(now, 2), now)).toBe(172_800);
    expect(secondsUntil(new Date('2025-01-01T00:00:00Z'), now)).toBe(0);
    expect(secondsUntil(null, now)).toBe(0);
  });

  it('describes seller tenure', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(tenureLabel(new Date('2020-06-01T00:00:00Z'), now)).toBe('5+ years on DOOAA');
    expect(tenureLabel(new Date('2024-12-01T00:00:00Z'), now)).toBe('1+ year on DOOAA');
    expect(tenureLabel(new Date('2025-09-01T00:00:00Z'), now)).toBe('4 months on DOOAA');
    expect(tenureLabel(new Date('2025-12-25T00:00:00Z'), now)).toBe('New on DOOAA');
    expect(yearsSince(new Date('2025-12-25T00:00:00Z'), now)).toBe(1);
  });
});
