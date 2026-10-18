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

/** A pooled SMTP transporter (Gmail, SES, Mailgun… or a local catcher such as Mailpit in development). */
export function createSmtpTransport(config: AppConfig['mail']['smtp']): MailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    pool: true,
    maxConnections: 3,
  });
}
