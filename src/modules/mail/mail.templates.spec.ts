import { escapeHtml, otpMail, renderMail, welcomeMail } from './mail.templates';

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
    expect(rendered.subject).toBe('Your DOOAA password reset code');
    expect(rendered.html).toContain('048213');
    expect(rendered.text).toContain('Your code: 048213');
    expect(rendered.text).toContain('expires in 10 minutes');
  });

  it('falls back to the verification copy for unknown purposes', () => {
    expect(otpMail('unknown', '111111', 5).subject).toBe('Your DOOAA verification code');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('keeps escrow out of the layout, and out of the welcome email while escrow is off', () => {
    const off = renderMail(welcomeMail('Ada', 'https://dooaa.com', false));
    expect(off.subject).toBe('Welcome to DOOAA, Ada');
    expect(off.html).not.toMatch(/escrow/i);
    expect(off.text).not.toMatch(/escrow/i);
    const on = renderMail(welcomeMail('Ada', 'https://dooaa.com', true));
    expect(on.text).toContain('hold the money safely');
    expect(renderMail(otpMail('sign-in', '123456', 10)).html).not.toMatch(/escrow/i);
  });
});

