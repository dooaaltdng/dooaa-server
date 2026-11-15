import { classifyTraffic } from './traffic';

const own = ['dooaa.com', 'localhost'];
const IG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0';
const TT_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36 musical_ly_2023';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

describe('classifyTraffic', () => {
  it('trusts a campaign tag first', () => {
    expect(classifyTraffic({ utmSource: 'instagram', referrer: 'https://www.google.com/', ownHosts: own })).toBe('instagram');
    expect(classifyTraffic({ utmSource: 'IG', ownHosts: own })).toBe('instagram');
    expect(classifyTraffic({ utmSource: 'newsletter', utmMedium: 'email', ownHosts: own })).toBe('email');
    expect(classifyTraffic({ utmSource: 'partner-blog', ownHosts: own })).toBe('other');
  });

  it('reads the referrer host', () => {
    expect(classifyTraffic({ referrer: 'https://www.google.com.ng/', ownHosts: own })).toBe('google');
    expect(classifyTraffic({ referrer: 'https://l.instagram.com/?u=x', ownHosts: own })).toBe('instagram');
    expect(classifyTraffic({ referrer: 'https://t.co/abc', ownHosts: own })).toBe('x');
    expect(classifyTraffic({ referrer: 'https://lm.facebook.com/', ownHosts: own })).toBe('facebook');
    expect(classifyTraffic({ referrer: 'https://www.tiktok.com/', ownHosts: own })).toBe('tiktok');
    expect(classifyTraffic({ referrer: 'https://www.bing.com/search?q=dooaa', ownHosts: own })).toBe('bing');
    expect(classifyTraffic({ referrer: 'https://nairaland.com/thread', ownHosts: own })).toBe('other');
  });

  it('ignores its own pages and falls back to the in-app browser', () => {
    expect(classifyTraffic({ referrer: 'https://www.dooaa.com/shop', userAgent: CHROME, ownHosts: own })).toBe('other');
    expect(classifyTraffic({ referrer: '', userAgent: IG_UA, ownHosts: own })).toBe('instagram');
    expect(classifyTraffic({ userAgent: TT_UA, ownHosts: own })).toBe('tiktok');
    expect(classifyTraffic({ userAgent: CHROME, ownHosts: own })).toBe('other');
  });
});
