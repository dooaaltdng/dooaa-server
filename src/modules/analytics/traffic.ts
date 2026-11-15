/**
 * Where a visit came from, for the dashboard's Traffic Sources card.
 *
 * The storefront sends, on the first page of a visit, the page's referrer and
 * any `utm_source` / `utm_medium` / `ref` it landed with; the server adds the
 * User-Agent. In order of trust:
 *   1. a campaign tag (utm_source / ref) — e.g. links in an Instagram bio
 *   2. the referrer's host — google.com, l.instagram.com, t.co …
 *   3. an in-app browser's User-Agent — Instagram, TikTok and Facebook open
 *      links in their own browsers, which often send no referrer at all
 *   4. otherwise "other": typed, bookmarked, or opened from an app that hides
 *      where it came from (WhatsApp, Telegram, email, SMS…), plus any site not
 *      listed here
 */

export const TRAFFIC_SOURCES = [
  'google',
  'instagram',
  'tiktok',
  'facebook',
  'x',
  'whatsapp',
  'youtube',
  'linkedin',
  'telegram',
  'bing',
  'email',
  'other',
] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export const TRAFFIC_LABEL: Record<TrafficSource, string> = {
  google: 'Google',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X (Twitter)',
  whatsapp: 'WhatsApp',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  telegram: 'Telegram',
  bing: 'Bing',
  email: 'Email',
  other: 'Other',
};

/** Words that name a source in a campaign tag or a referrer host. */
const NAMES: [TrafficSource, RegExp][] = [
  ['google', /(^|\.|\b)google(\.|\b)|googleadservices|gclid/],
  ['instagram', /instagram|(^|\.)ig(\.|$)|^ig$/],
  ['tiktok', /tiktok|musical\.?ly|bytedance/],
  ['facebook', /facebook|(^|\.)fb(\.|$)|^fb$|fb\.me|messenger/],
  ['x', /twitter|(^|\.)t\.co$|^x$|(^|\.)x\.com$/],
  ['whatsapp', /whatsapp|wa\.me/],
  ['youtube', /youtube|youtu\.be/],
  ['linkedin', /linkedin|lnkd\.in/],
  ['telegram', /telegram|(^|\.)t\.me$/],
  ['bing', /(^|\.)bing\./],
  ['email', /^e-?mail$|newsletter|mailchimp|^mail\.|outlook|gmail/],
];

/** In-app browsers that tend to drop the referrer. */
const APPS: [TrafficSource, RegExp][] = [
  ['instagram', /Instagram/i],
  ['tiktok', /TikTok|musical_ly|BytedanceWebview|trill_/i],
  ['facebook', /FBAN|FBAV|FB_IAB|FBIOS/i],
  ['x', /Twitter/i],
  ['linkedin', /LinkedInApp/i],
  ['telegram', /Telegram/i],
];

function named(value: string): TrafficSource | null {
  const text = value.toLowerCase().trim();
  if (!text) return null;
  return NAMES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function classifyTraffic(input: {
  utmSource?: string | null;
  utmMedium?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
  /** The storefront's own hosts; a referrer from these is not a source. */
  ownHosts: string[];
}): TrafficSource {
  const tag = input.utmSource?.trim();
  if (tag) {
    if (input.utmMedium && /^e-?mail$/i.test(input.utmMedium.trim())) return 'email';
    return named(tag) ?? 'other';
  }

  const host = input.referrer ? hostOf(input.referrer) : null;
  const own = new Set(input.ownHosts.map((h) => h.toLowerCase().replace(/^www\./, '')));
  if (host && !own.has(host)) return named(host) ?? 'other';

  const agent = input.userAgent ?? '';
  const app = APPS.find(([, pattern]) => pattern.test(agent))?.[0];
  if (app) return app;

  return 'other';
}
