import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Errors } from '../../common/api/app-error';
import type { OtpChannel, OtpPurpose } from '../../common/domain';
import { maskEmail, maskPhone } from '../../common/util/text';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { otps } from '../../database/schema';
import { MailService } from '../mail/mail.service';
import { otpMail } from '../mail/mail.templates';
import { SmsService } from '../sms/sms.service';

export type OtpRecord = typeof otps.$inferSelect;

export type IssueOtpInput = {
  key: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
  /** Email address or phone number the code goes to. */
  to: string;
  userId?: string;
  context?: string;
};

export type IssuedOtp = {
  sent: true;
  channel: OtpChannel;
  /** Masked destination, for "We sent a code to ne•••@gmail.com". */
  sentTo: string;
  expiresAt: string;
  /** When "Resend code" becomes available. */
  resendAt: string;
};

const OTP_LENGTH = 6;

@Injectable()
export class OtpService {
  constructor(
    @InjectDb() private readonly db: Database,
    @InjectConfig() private readonly config: AppConfig,
    private readonly mail: MailService,
    private readonly sms: SmsService,
  ) {}

  private hash(key: string, purpose: string, context: string, code: string): string {
    return createHash('sha256').update(`${this.config.otp.pepper}:${key}:${purpose}:${context}:${code}`).digest('hex');
  }

  generateCode(): string {
    return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
  }

  async issue(input: IssueOtpInput): Promise<IssuedOtp> {
    const context = input.context ?? '';
    const now = Date.now();
    const cooldownMs = this.config.otp.resendCooldownSeconds * 1000;

    const [latest] = await this.db
      .select({ createdAt: otps.createdAt })
      .from(otps)
      .where(and(eq(otps.key, input.key), eq(otps.purpose, input.purpose), eq(otps.context, context)))
      .orderBy(desc(otps.createdAt))
      .limit(1);
    if (latest && now - latest.createdAt.getTime() < cooldownMs) {
      const retryAfter = Math.ceil((cooldownMs - (now - latest.createdAt.getTime())) / 1000);
      throw Errors.tooMany(`Please wait ${retryAfter}s before requesting another code.`, 'OTP_COOLDOWN', {
        retryAfterSeconds: retryAfter,
      });
    }

    const code = this.generateCode();
    const expiresAt = new Date(now + this.config.otp.ttlSeconds * 1000);
    // A new code replaces any earlier one for the same purpose.
    await this.db.transaction(async (tx) => {
      await tx.delete(otps).where(and(eq(otps.key, input.key), eq(otps.purpose, input.purpose), eq(otps.context, context), isNull(otps.consumedAt)));
      await tx.insert(otps).values({
        key: input.key,
        purpose: input.purpose,
        context,
        channel: input.channel,
        codeHash: this.hash(input.key, input.purpose, context, code),
        userId: input.userId ?? null,
        expiresAt,
      });
    });

    const minutes = Math.round(this.config.otp.ttlSeconds / 60);
    if (input.channel === 'email') {
      void this.mail.send(input.to, otpMail(input.purpose, code, minutes));
    } else {
      void this.sms.send(
        input.to,
        `Your DOOAA code is ${code}. It expires in ${minutes} minutes. Never share it with anyone.`,
        input.channel,
      );
    }

    return {
      sent: true,
      channel: input.channel,
      sentTo: input.channel === 'email' ? maskEmail(input.to) : maskPhone(input.to),
      expiresAt: expiresAt.toISOString(),
      resendAt: new Date(now + cooldownMs).toISOString(),
    };
  }

  /**
   * Checks a code and, by default, consumes it. Wrong codes count against a
   * small attempt budget, after which the code is dead.
   */
  async verify(input: { key: string; purpose: OtpPurpose; code: string; context?: string; consume?: boolean }): Promise<OtpRecord> {
    const context = input.context ?? '';
    const [record] = await this.db
      .select()
      .from(otps)
      .where(and(eq(otps.key, input.key), eq(otps.purpose, input.purpose), eq(otps.context, context), isNull(otps.consumedAt), gt(otps.expiresAt, new Date())))
      .orderBy(desc(otps.createdAt))
      .limit(1);
    if (!record) {
      throw Errors.badRequest('That code has expired. Request a new one.', 'OTP_EXPIRED');
    }
    if (record.attempts >= this.config.otp.maxAttempts) {
      throw Errors.tooMany('Too many incorrect attempts. Request a new code.', 'OTP_LOCKED');
    }

    const code = String(input.code ?? '').trim();
    const devMatch = Boolean(this.config.otp.devCode) && code === this.config.otp.devCode;
    const expected = Buffer.from(record.codeHash, 'hex');
    const actual = Buffer.from(this.hash(input.key, input.purpose, context, code), 'hex');
    const matches = devMatch || (expected.length === actual.length && timingSafeEqual(expected, actual));

    if (!matches) {
      const [updated] = await this.db
        .update(otps)
        .set({ attempts: sql`${otps.attempts} + 1` })
        .where(eq(otps.id, record.id))
        .returning({ attempts: otps.attempts });
      const left = Math.max(0, this.config.otp.maxAttempts - (updated?.attempts ?? record.attempts + 1));
      throw Errors.badRequest('Incorrect code. Check your messages and enter the code again.', 'OTP_INVALID', {
        attemptsLeft: left,
      });
    }

    if (input.consume !== false) {
      const consumed = await this.db
        .update(otps)
        .set({ consumedAt: new Date() })
        .where(and(eq(otps.id, record.id), isNull(otps.consumedAt)))
        .returning({ id: otps.id });
      if (!consumed.length) throw Errors.badRequest('That code has already been used.', 'OTP_USED');
    }
    return record;
  }
}
