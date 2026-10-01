import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { maskEmail, maskPhone } from '../../common/util/text';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { MailService } from '../mail/mail.service';
import { otpMail } from '../mail/mail.templates';
import { SmsService } from '../sms/sms.service';
import { Otp, type OtpChannel, type OtpPurpose } from './otp.schema';

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
    @InjectModel(Otp.name) private readonly otps: Model<Otp>,
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

    const latest = await this.otps
      .findOne({ key: input.key, purpose: input.purpose, context })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();
    if (latest && now - latest.createdAt.getTime() < cooldownMs) {
      const retryAfter = Math.ceil((cooldownMs - (now - latest.createdAt.getTime())) / 1000);
      throw Errors.tooMany(`Please wait ${retryAfter}s before requesting another code.`, 'OTP_COOLDOWN', {
        retryAfterSeconds: retryAfter,
      });
    }

    // A new code replaces any earlier one for the same purpose.
    await this.otps.deleteMany({ key: input.key, purpose: input.purpose, context, consumedAt: null });

    const code = this.generateCode();
    const expiresAt = new Date(now + this.config.otp.ttlSeconds * 1000);
    await this.otps.create({
      key: input.key,
      purpose: input.purpose,
      context,
      channel: input.channel,
      codeHash: this.hash(input.key, input.purpose, context, code),
      userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
      expiresAt,
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
  async verify(input: { key: string; purpose: OtpPurpose; code: string; context?: string; consume?: boolean }): Promise<Otp & { _id: Types.ObjectId }> {
    const context = input.context ?? '';
    const record = await this.otps
      .findOne({ key: input.key, purpose: input.purpose, context, consumedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();
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
      const updated = await this.otps.findOneAndUpdate(
        { _id: record._id },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      );
      const left = Math.max(0, this.config.otp.maxAttempts - (updated?.attempts ?? record.attempts + 1));
      throw Errors.badRequest('Incorrect code. Check your messages and enter the code again.', 'OTP_INVALID', {
        attemptsLeft: left,
      });
    }

    if (input.consume !== false) {
      const consumed = await this.otps.findOneAndUpdate(
        { _id: record._id, consumedAt: null },
        { $set: { consumedAt: new Date() } },
      );
      if (!consumed) throw Errors.badRequest('That code has already been used.', 'OTP_USED');
    }
    return record;
  }
}
