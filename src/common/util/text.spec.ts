import { containsRegex, escapeRegex, excerpt, fullName, looksLikeEmail, maskEmail, maskLast4, maskPhone, normalizeEmail, normalizePhone, shortName, slugify } from './text';

describe('text', () => {
  it('normalizes Nigerian phone numbers to E.164', () => {
    expect(normalizePhone('09027293293')).toBe('+2349027293293');
    expect(normalizePhone('9027293293')).toBe('+2349027293293');
    expect(normalizePhone('+234 902 729 3293')).toBe('+2349027293293');
    expect(normalizePhone('2349027293293')).toBe('+2349027293293');
    expect(normalizePhone('')).toBe('');
  });

  it('masks contact details for "we sent a code to …"', () => {
    expect(maskEmail('nelson1234@gmail.com')).toBe('ne••••••••@gmail.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
    expect(maskPhone('+2349027293293')).toBe('+234 ••• ••• 3293');
    expect(maskLast4('3892')).toBe('**** 3892');
    expect(maskLast4(undefined)).toBe('****');
  });

  it('escapes user search terms before they become regexes', () => {
    expect(escapeRegex('a.b*c(d)')).toBe('a\\.b\\*c\\(d\\)');
    expect(containsRegex(' iPhone (12) ').test('Apple iPhone (12) Pro')).toBe(true);
    expect(containsRegex('.*').test('anything')).toBe(false);
  });

  it('recognises emails and normalizes them', () => {
    expect(looksLikeEmail('nelson@dooaa.ng')).toBe(true);
    expect(looksLikeEmail('09027293293')).toBe(false);
    expect(normalizeEmail('  Nelson@Dooaa.COM ')).toBe('nelson@dooaa.com');
  });

  it('builds the names the designs use', () => {
    expect(shortName('Melissa Jones')).toBe('M.Jones');
    expect(shortName('Oluwa Sefunmi Abimbola')).toBe('O.Sefunmi Abimbola');
    expect(shortName('Cher')).toBe('Cher');
    expect(fullName({ firstName: 'Nelson', lastName: 'Okafor' })).toBe('Nelson Okafor');
    expect(fullName(null)).toBe('');
  });

  it('cuts excerpts on a word boundary', () => {
    expect(excerpt('short text', 120)).toBe('short text');
    const long = 'Experience cutting-edge performance and unmatched versatility with the Samsung Galaxy S23 Ultra 5G designed for power users';
    const cut = excerpt(long, 60);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(61);
    expect(cut).not.toMatch(/\s…$/);
  });

  it('slugifies', () => {
    expect(slugify('Beauty & Health')).toBe('beauty-and-health');
    expect(slugify('  Toys / Games  ')).toBe('toys-games');
    expect(slugify('Café Crème')).toBe('cafe-creme');
  });
});
