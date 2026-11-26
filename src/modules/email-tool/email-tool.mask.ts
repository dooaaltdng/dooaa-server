/** "Chidi Okafor" → "Ch*** O***". Keeps the first letters so the marketer can tell people apart. */
export function maskName(first: string, last: string): string {
  const part = (word: string, keep: number) => (word ? word.slice(0, keep) + '*'.repeat(Math.max(2, Math.min(5, word.length - keep))) : '');
  return [part(first.trim(), 2), part(last.trim(), 1)].filter(Boolean).join(' ') || '—';
}

/** "chidi.okafor@gmail.com" → "ch***@g***.com". */
export function maskEmail(email: string): string {
  const [local, domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, Math.min(2, local.length))}***@${host.slice(0, 1)}***${tld}`;
}
