import { sanitizeContent } from './sanitize';
import { defaultPages, policyHtml } from './seed/pages';
import { POLICIES } from './seed/policies';

describe('content sanitising', () => {
  it('keeps the editor’s formatting', () => {
    const html = '<h2>Title</h2><p style="text-align:center"><strong>Bold</strong> <em>i</em> <u>u</u></p><ul><li>One</li></ul>';
    expect(sanitizeContent(html)).toBe(html);
  });

  it('strips scripts, handlers, iframes and dangerous links', () => {
    const dirty = '<p onclick="steal()">Hi<script>alert(1)</script></p><iframe src="https://evil"></iframe><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>';
    const clean = sanitizeContent(dirty);
    expect(clean).not.toMatch(/script|onclick|iframe|javascript:|onerror|<img/i);
    expect(clean).toContain('<p>Hi</p>');
  });

  it('only allows alignment as an inline style', () => {
    expect(sanitizeContent('<p style="color:red;text-align:right;background:url(x)">x</p>')).toBe('<p style="text-align:right">x</p>');
  });

  it('hardens links', () => {
    expect(sanitizeContent('<a href="https://dooaa.ng" target="_self">x</a>')).toBe('<a href="https://dooaa.ng" target="_blank" rel="noopener noreferrer">x</a>');
    expect(sanitizeContent('<a href="mailto:support@dooaa.com">mail</a>')).toBe('<a href="mailto:support@dooaa.com" rel="noopener noreferrer">mail</a>');
  });
});

describe('default pages', () => {
  it('seeds the six console pages in the frame’s order, with the client’s policy copy', () => {
    const pages = defaultPages();
    expect(pages.map((page) => page.slug)).toEqual(['about', 'help', 'privacy', 'terms', 'refunds', 'safety']);
    const refunds = pages.find((page) => page.slug === 'refunds')!;
    expect(refunds.title).toBe('Refund & Return Policy');
    expect(refunds.body).toContain('<h2>Eligibility for Refund</h2>');
    expect(refunds.body).toContain('<li>The item is damaged, defective, or incomplete.</li>');
  });

  it('renders every block type, escaping text', () => {
    for (const policy of POLICIES) expect(policyHtml(policy)).not.toContain('undefined');
    const html = policyHtml({
      slug: 'x',
      heroTitle: 'x',
      heroSubtitle: 'x',
      metaDescription: 'x',
      sections: [{ heading: 'A & B', blocks: [{ type: 'ol', items: ['one', { text: 'two', sub: ['2a'] }] }, { type: 'contact', email: 'a@b.co', address: '1 <Street>' }] }],
    });
    expect(html).toBe('<h2>A &amp; B</h2><ol><li>one</li><li>two<ul><li>2a</li></ul></li></ol><p><strong>Email:</strong> <a href="mailto:a@b.co">a@b.co</a><br><strong>Address:</strong> 1 &lt;Street&gt;</p>');
  });
});
