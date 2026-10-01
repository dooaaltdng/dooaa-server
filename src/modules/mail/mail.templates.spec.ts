import { escapeHtml, otpMail, renderMail } from './mail.templates';

describe('mail templates', () => {
  it('escapes everything interpolated into the HTML', () => {
    const rendered = renderMail({
      subject: 'Hi',
      heading: '<img src=x onerror=alert(1)>',
      paragraphs: ['Tom & "Jerry"'],
      cta: { label: 'Go', url: 'https://dooaa.ng/?a=1&b="2"' },
    });
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).toContain('Tom &amp; &quot;Jerry&quot;');
    expect(rendered.html).toContain('href="https://dooaa.ng/?a=1&amp;b=&quot;2&quot;"');
    expect(rendered.text).toContain('Go: https://dooaa.ng/?a=1&b="2"');
  });

  it('renders one-time codes in both parts', () => {
    const rendered = renderMail(otpMail('reset-password', '048213', 10));
    expect(rendered.subject).toBe('Reset your DOOAA password');
    expect(rendered.html).toContain('048213');
    expect(rendered.text).toContain('Code: 048213');
    expect(rendered.text).toContain('expires in 10 minutes');
  });

  it('falls back to the verification copy for unknown purposes', () => {
    expect(otpMail('unknown', '111111', 5).subject).toBe('Your DOOAA verification code');
    expect(escapeHtml("'")).toBe('&#39;');
  });
});
