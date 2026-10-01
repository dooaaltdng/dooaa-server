/**
 * Dates are stored in UTC. Anything rendered as a day or a clock is rendered
 * in Lagos time (WAT, UTC+1, no daylight saving), the marketplace's zone.
 */
export const TIME_ZONE = 'Africa/Lagos';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** "2025-10-23" in Lagos. */
export function dayKey(date: Date | number | string = new Date()): string {
  return DAY_KEY.format(new Date(date));
}

/** "2025-10" in Lagos. */
export function monthKey(date: Date | number | string = new Date()): string {
  return dayKey(date).slice(0, 7);
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** "04:15pm" — the caption clock every thread in the designs uses. */
export function clockTime(date: Date | number | string): string {
  const parts = CLOCK.formatToParts(new Date(date));
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '12';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const period = (parts.find((part) => part.type === 'dayPeriod')?.value ?? 'AM').toLowerCase();
  return `${hour.padStart(2, '0')}:${minute}${period}`;
}

/** "10:30 AM". */
export function clockTimeUpper(date: Date | number | string): string {
  const value = clockTime(date);
  return `${value.slice(0, 5)} ${value.slice(5).toUpperCase()}`;
}

const LONG = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 23, 2025". */
export function longDate(date: Date | number | string): string {
  return LONG.format(new Date(date));
}

const MONTH_LONG = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'long' });
const DAY_NUM = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, day: 'numeric' });
const YEAR = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric' });

export function ordinal(day: number): string {
  if (day % 100 > 10 && day % 100 < 14) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** "June 23rd, 2025" — the escrow timeline's date form. */
export function ordinalDate(date: Date | number | string): string {
  const value = new Date(date);
  return `${MONTH_LONG.format(value)} ${ordinal(Number(DAY_NUM.format(value)))}, ${YEAR.format(value)}`;
}

const SHORT_STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Oct 25, 11:45 AM" — the tracking step stamp. */
export function shortStamp(date: Date | number | string): string {
  return SHORT_STAMP.format(new Date(date));
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function addDays(date: Date, days: number): Date {
  return addMs(date, days * DAY);
}

export function addHours(date: Date, hours: number): Date {
  return addMs(date, hours * HOUR);
}

/** Midnight Lagos time of the given instant, as a UTC Date. */
export function startOfLagosDay(date: Date | number | string = new Date()): Date {
  return new Date(`${dayKey(date)}T00:00:00+01:00`);
}

/** Whole seconds from now until `date`, floored at zero. */
export function secondsUntil(date: Date | null | undefined, now: Date = new Date()): number {
  if (!date) return 0;
  return Math.max(0, Math.floor((new Date(date).getTime() - now.getTime()) / 1000));
}

/** "5+ years on DOOAA" style tenure from a join date. */
export function tenureLabel(joined: Date, now: Date = new Date()): string {
  const years = Math.floor((now.getTime() - new Date(joined).getTime()) / (365.25 * DAY));
  if (years >= 1) return `${years}+ ${years === 1 ? 'year' : 'years'} on DOOAA`;
  const months = Math.floor((now.getTime() - new Date(joined).getTime()) / (30.44 * DAY));
  if (months >= 1) return `${months} ${months === 1 ? 'month' : 'months'} on DOOAA`;
  return 'New on DOOAA';
}

/** Whole years since a date, floored at 1 — the admin listing's "seller years". */
export function yearsSince(date: Date, now: Date = new Date()): number {
  return Math.max(1, Math.floor((now.getTime() - new Date(date).getTime()) / (365.25 * DAY)));
}
