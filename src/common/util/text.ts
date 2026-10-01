export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive "contains" regex for a user-supplied search term. */
export function containsRegex(term: string): RegExp {
  return new RegExp(escapeRegex(term.trim()), 'i');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits only, with a Nigerian leading 0 or 234 normalised to +234. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('234')) return `+${digits}`;
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`;
  return `+${digits}`;
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** "ne•••@gmail.com" */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'•'.repeat(Math.max(3, user.length - visible.length))}@${domain}`;
}

/** "+234 ••• ••• 3293" */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return phone;
  return `+${digits.slice(0, 3)} ••• ••• ${digits.slice(-4)}`;
}

/** "**** 3892" */
export function maskLast4(last4?: string | null): string {
  return last4 ? `**** ${last4}` : '****';
}

/** "Chidinma Okafor" → "C.Okafor", the abbreviation the dispute pane uses. */
export function shortName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first[0]}.${rest.join(' ')}` : first;
}

export function fullName(person: { firstName?: string; lastName?: string } | null | undefined): string {
  if (!person) return '';
  return [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
}

/** First ~`length` characters on a word boundary, with an ellipsis when cut. */
export function excerpt(text: string, length = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= length) return clean;
  const cut = clean.slice(0, length);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > length * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
