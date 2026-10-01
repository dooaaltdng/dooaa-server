/**
 * Transactional email copy. Every template is a heading, a few short
 * paragraphs and at most one call to action, rendered into one branded
 * layout. All interpolated values are escaped.
 */

export type MailCta = { label: string; url: string };

export type MailContent = {
  subject: string;
  heading: string;
  paragraphs: string[];
  cta?: MailCta;
  /** Shown large and spaced, for one-time codes. */
  code?: string;
  footnote?: string;
};

export type RenderedMail = { subject: string; html: string; text: string };

const BRAND = '#1eb4ee';
const INK = '#0d1828';
const MUTED = '#5b6474';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMail(content: MailContent): RenderedMail {
  const paragraphs = content.paragraphs
    .map((line) => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:${INK}">${escapeHtml(line)}</p>`)
    .join('');
  const code = content.code
    ? `<div style="margin:8px 0 20px;padding:16px;border-radius:10px;background:#e9f7fd;text-align:center;font-size:30px;letter-spacing:10px;font-weight:700;color:${INK}">${escapeHtml(content.code)}</div>`
    : '';
  const cta = content.cta
    ? `<p style="margin:22px 0"><a href="${escapeHtml(content.cta.url)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">${escapeHtml(content.cta.label)}</a></p>`
    : '';
  const footnote = content.footnote
    ? `<p style="margin:18px 0 0;font-size:13px;line-height:19px;color:${MUTED}">${escapeHtml(content.footnote)}</p>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${INK};padding:18px 28px;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:1px">DOOAA<span style="color:${BRAND}">.NG</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:21px;line-height:28px;color:${INK}">${escapeHtml(content.heading)}</h1>
${paragraphs}${code}${cta}${footnote}
</td></tr>
<tr><td style="padding:16px 28px;background:#f9fafb;font-size:12px;line-height:18px;color:${MUTED}">You are receiving this because you have an account on DOOAA. Keep payments and messages on DOOAA so escrow can protect you.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    content.heading,
    '',
    ...content.paragraphs,
    ...(content.code ? ['', `Code: ${content.code}`] : []),
    ...(content.cta ? ['', `${content.cta.label}: ${content.cta.url}`] : []),
    ...(content.footnote ? ['', content.footnote] : []),
    '',
    '— DOOAA',
  ].join('\n');

  return { subject: content.subject, html, text };
}

export type OtpPurposeCopy = { subject: string; heading: string; lead: string };

export const OTP_COPY: Record<string, OtpPurposeCopy> = {
  'verify-email': {
    subject: 'Your DOOAA verification code',
    heading: 'Confirm your email address',
    lead: 'Enter this code to finish setting up your DOOAA account.',
  },
  'reset-password': {
    subject: 'Reset your DOOAA password',
    heading: 'Reset your password',
    lead: 'Enter this code to choose a new password. If you did not ask for this, you can ignore this email.',
  },
  'change-password': {
    subject: 'Confirm your password change',
    heading: 'Confirm it is you',
    lead: 'Enter this code to change the password on your DOOAA account.',
  },
  'confirm-release': {
    subject: 'Confirm your purchase on DOOAA',
    heading: 'Confirm your purchase',
    lead: 'Enter this code to confirm the item arrived as described and release payment to the seller.',
  },
  'verify-phone': {
    subject: 'Your DOOAA code',
    heading: 'Confirm your phone number',
    lead: 'Enter this code to confirm your phone number.',
  },
};

export function otpMail(purpose: string, code: string, minutes: number): MailContent {
  const copy = OTP_COPY[purpose] ?? OTP_COPY['verify-email'];
  return {
    subject: copy.subject,
    heading: copy.heading,
    paragraphs: [copy.lead],
    code,
    footnote: `The code expires in ${minutes} minutes. DOOAA staff will never ask you for it.`,
  };
}
