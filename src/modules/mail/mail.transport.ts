import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/configuration';

/** One outgoing message, as nodemailer takes it. */
export type OutgoingMail = { from: string; to: string; subject: string; html: string; text: string; replyTo?: string };

/** The part of a nodemailer transporter the mail service uses. */
export interface MailTransport {
  sendMail(message: OutgoingMail): Promise<unknown>;
  close(): void;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** The host's IPv4 address, or the host itself when it has none (or is already an IP / localhost). */
async function ipv4For(host: string): Promise<string> {
  if (!host || isIP(host) || host === 'localhost') return host;
  try {
    const [address] = await dns.resolve4(host);
    return address ?? host;
  } catch {
    return host;
  }
}

/**
 * A pooled SMTP transporter (Gmail, SES, Mailgun… or a local catcher such as Mailpit in development).
 *
 * It connects over IPv4: the production host (pxxl) has no IPv6 route, and nodemailer
 * sometimes picks the provider's IPv6 address (Gmail → ECONNREFUSED 2a00:…:465), which
 * silently drops OTP emails. TLS still verifies against the real host name.
 */
export function createSmtpTransport(config: AppConfig['mail']['smtp']): MailTransport {
  const build = async () => {
    const address = await ipv4For(config.host);
    return nodemailer.createTransport({
      host: address,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      tls: address !== config.host ? { servername: config.host } : undefined,
      pool: true,
      maxConnections: 3,
    });
  };

  let transporter: ReturnType<typeof build> | null = null;

  return {
    async sendMail(message) {
      transporter ??= build();
      try {
        return await (await transporter).sendMail(message);
      } catch (err) {
        // Re-resolve on the next send in case the provider's address changed.
        const old = transporter;
        transporter = null;
        void old.then((t) => t.close()).catch(() => undefined);
        throw err;
      }
    },
    close() {
      void transporter?.then((t) => t.close()).catch(() => undefined);
    },
  };
}
