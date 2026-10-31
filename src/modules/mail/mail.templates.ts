/**
 * Transactional email copy. Every template is a heading, a few short
 * paragraphs and at most one call to action, rendered into one branded
 * layout. All interpolated values are escaped.
 */

export type MailCta = { label: string; url: string };

export type MailContent = {
  subject: string;
  /** The inbox preview line beside the subject: it adds to it, never repeats it. */
  preheader?: string;
  heading: string;
  paragraphs: string[];
  cta?: MailCta;
  /** Shown large and spaced near the top, for one-time codes. */
  code?: string;
  footnote?: string;
};

export type RenderedMail = { subject: string; html: string; text: string };

const BRAND = '#1eb4ee';
const BRAND_DARK = '#0b7fb0';
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

/**
 * One layout for every email, written to transactional-email practice: the
 * subject names the event, the preheader adds to it, a code sits at the top
 * with its expiry right under it, there is at most one 44px button, and the
 * footer tells people a real team reads their replies. Nothing here mentions
 * escrow: the copy that does checks whether escrow is in play first.
 */
export function renderMail(content: MailContent): RenderedMail {
  const preheader = content.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(content.preheader)}</div>`
    : '';
  const paragraphs = content.paragraphs
    .map((line) => `<p style="margin:0 0 14px;font-size:16px;line-height:24px;color:${INK}">${escapeHtml(line)}</p>`)
    .join('');
  const code = content.code
    ? `<div style="margin:4px 0 8px;padding:18px 12px;border-radius:12px;background:#e9f7fd;text-align:center;font-size:32px;letter-spacing:10px;font-weight:700;color:${INK};font-family:'Courier New',monospace">${escapeHtml(content.code)}</div>`
    : '';
  const cta = content.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px"><tr><td style="border-radius:10px;background:${BRAND}"><a href="${escapeHtml(content.cta.url)}" style="display:inline-block;min-width:180px;padding:13px 24px;border-radius:10px;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;line-height:20px;text-align:center">${escapeHtml(content.cta.label)}</a></td></tr></table>`
    : '';
  const footnote = content.footnote
    ? `<p style="margin:${content.code ? '0 0 18px' : '18px 0 0'};font-size:14px;line-height:20px;color:${MUTED}">${escapeHtml(content.footnote)}</p>`
    : '';
  // A code goes straight under the heading, with its expiry beneath it; everything else follows.
  const body = content.code ? `${code}${footnote}${paragraphs}${cta}` : `${paragraphs}${cta}${footnote}`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif">${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="padding:22px 28px 0;font-size:22px;font-weight:800;letter-spacing:1px;color:${INK}">DOOAA<span style="color:${BRAND}">.</span></td></tr>
<tr><td style="padding:18px 28px 28px">
<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;color:${INK}">${escapeHtml(content.heading)}</h1>
${body}
<p style="margin:22px 0 0;font-size:16px;line-height:24px;color:${INK}">The DOOAA team</p>
</td></tr>
<tr><td style="padding:18px 28px;background:#f9fafb;font-size:13px;line-height:20px;color:${MUTED}">Questions? Just reply to this email and a real person on our team will help. You are receiving this because you have a DOOAA account.<br><a href="https://dooaa.com" style="color:${BRAND_DARK};text-decoration:underline">dooaa.com</a> · Buy and sell with confidence</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    content.heading,
    '',
    ...(content.code ? [`Your code: ${content.code}`, ...(content.footnote ? [content.footnote] : []), ''] : []),
    ...content.paragraphs,
    ...(content.cta ? ['', `${content.cta.label}: ${content.cta.url}`] : []),
    ...(!content.code && content.footnote ? ['', content.footnote] : []),
    '',
    'The DOOAA team',
    'Questions? Just reply to this email.',
  ].join('\n');

  return { subject: content.subject, html, text };
}

/** The welcome email, sent once the email address is confirmed. Mentions escrow only while it is switched on. */
export function welcomeMail(firstName: string, platformUrl: string, escrow: boolean): MailContent {
  return {
    subject: `Welcome to DOOAA, ${firstName}`,
    preheader: 'Your account is ready. Here is how to make the most of it.',
    heading: `You're in, ${firstName}!`,
    paragraphs: [
      'Your email is confirmed and your DOOAA account is ready to go.',
      'Find great deals on new and used items from sellers across Nigeria, chat with them directly, and agree on what works for you.',
      escrow
        ? 'When you pay through DOOAA, we hold the money safely until you confirm your item arrived as described.'
        : 'Tip: keep your chats on DOOAA. It keeps a record of what you agreed and helps us support you if anything goes wrong.',
    ],
    cta: { label: 'Start shopping', url: platformUrl },
  };
}

/** "You have a new message" — sent when a message has waited 10 minutes without being read. */
export function messageReminderMail(input: {
  firstName: string;
  senderName: string;
  itemTitle: string | null;
  preview: string;
  url: string;
}): MailContent {
  const about = input.itemTitle ? ` about ${input.itemTitle}` : '';
  return {
    subject: `${input.senderName} is waiting for your reply`,
    preheader: input.preview ? `“${input.preview.slice(0, 90)}”` : `You have an unread message${about}.`,
    heading: `${input.senderName} sent you a message`,
    paragraphs: [
      `Hi ${input.firstName}, you have an unread message${about}.`,
      ...(input.preview ? [`“${input.preview.slice(0, 160)}”`] : []),
      'Quick replies help deals happen. Most buyers and sellers who answer within the hour close the deal.',
    ],
    cta: { label: 'Reply now', url: input.url },
    footnote: 'You can choose which emails you get in your account settings.',
  };
}

export type OtpPurposeCopy = { subject: string; heading: string; lead: string };

export const OTP_COPY: Record<string, OtpPurposeCopy> = {
  'close-account': {
    subject: 'Your code to delete your DOOAA account',
    heading: 'Confirm account deletion',
    lead: 'Enter this code to permanently delete your account. Changed your mind? Ignore this email and nothing will happen.',
  },
  'sign-in': {
    subject: 'Your DOOAA sign-in code',
    heading: 'Here is your sign-in code',
    lead: 'Enter it on DOOAA to pick up where you left off. If you did not try to sign in, you can safely ignore this email.',
  },
  'verify-email': {
    subject: 'Your DOOAA verification code',
    heading: 'Almost there! Confirm your email',
    lead: 'Enter this code to finish creating your account and start buying and selling.',
  },
  'reset-password': {
    subject: 'Your DOOAA password reset code',
    heading: 'Reset your password',
    lead: 'Enter this code to choose a new password. If you did not ask for this, ignore this email and your password stays the same.',
  },
  'change-password': {
    subject: 'Your code to change your password',
    heading: 'Confirm it is you',
    lead: 'Enter this code to change the password on your DOOAA account.',
  },
  'confirm-release': {
    subject: 'Your code to confirm your purchase',
    heading: 'Confirm your purchase',
    lead: 'Enter this code to confirm your item arrived as described. The seller is paid once you do.',
  },
  'verify-phone': {
    subject: 'Your DOOAA phone code',
    heading: 'Confirm your phone number',
    lead: 'Enter this code to confirm your phone number.',
  },
};

export function otpMail(purpose: string, code: string, minutes: number): MailContent {
  const copy = OTP_COPY[purpose] ?? OTP_COPY['verify-email'];
  return {
    subject: copy.subject,
    preheader: `${code} is your code. It expires in ${minutes} minutes.`,
    heading: copy.heading,
    paragraphs: [copy.lead],
    code,
    footnote: `This code expires in ${minutes} minutes. Never share it: the DOOAA team will never ask you for it.`,
  };
}
