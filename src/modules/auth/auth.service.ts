import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import type { UserRole } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import { looksLikeEmail } from '../../common/util/text';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { MailService } from '../mail/mail.service';
import { OtpService, type IssuedOtp } from '../otp/otp.service';
import type { OtpChannel } from '../otp/otp.schema';
import { PasswordService } from '../users/password.service';
import { User } from '../users/schemas/user.schema';
import { toPublicUser, type PublicUser } from '../users/user.presenter';
import { UsersService } from '../users/users.service';
import type { ForgotPasswordDto, SendOtpDto, SignInDto, SignUpDto, VerifyOtpDto } from './dto/auth.dto';
import { TokenService, type SessionMeta, type TokenPair } from './token.service';

export type AuthResult = { user: PublicUser; tokens: TokenPair };

type ResetTokenPayload = { sub: string; typ: 'reset'; ver: number };

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectModel(User.name) private readonly userModel: Model<User>,
  ) {}

  /** OTP lookups are keyed by account, whatever channel the code travels on. */
  static otpKey(userId: string | Types.ObjectId): string {
    return `user:${String(userId)}`;
  }

  async signUp(input: SignUpDto, meta: SessionMeta): Promise<AuthResult & { verification: IssuedOtp }> {
    if (await this.users.findByEmail(input.email)) {
      throw Errors.conflict('An account with that email already exists.', 'EMAIL_TAKEN');
    }
    const user = await this.users.create({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      passwordHash: await this.passwords.hash(input.password),
    });
    const verification = await this.otp.issue({
      key: AuthService.otpKey(user._id),
      purpose: 'verify-email',
      channel: 'email',
      to: user.email,
      userId: String(user._id),
    });
    const tokens = await this.tokens.issue('user', String(user._id), user.tokenVersion ?? 0, meta);
    return { user: toPublicUser(user), tokens, verification };
  }

  async signIn(input: SignInDto, meta: SessionMeta): Promise<AuthResult> {
    const user = await this.users.findByEmail(input.email, true);
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw Errors.tooMany(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'ACCOUNT_LOCKED');
    }
    const valid = await this.passwords.verify(input.password, user?.passwordHash);
    if (!user || !valid) {
      if (user) {
        const locked = await this.users.recordFailedSignIn(String(user._id), this.config.auth.maxFailedSignIns, this.config.auth.lockMinutes);
        if (locked) {
          throw Errors.tooMany(`Too many failed attempts. Try again in ${this.config.auth.lockMinutes} minutes.`, 'ACCOUNT_LOCKED');
        }
      }
      throw Errors.unauthorized('Incorrect email or password.', 'INVALID_CREDENTIALS');
    }
    this.assertCanSignIn(user);
    await this.users.recordSignIn(String(user._id));
    const tokens = await this.tokens.issue('user', String(user._id), user.tokenVersion ?? 0, meta);
    const fresh = await this.users.getById(user._id);
    return { user: toPublicUser(fresh), tokens };
  }

  private assertCanSignIn(user: Lean<User>): void {
    if (user.status === 'closed') throw Errors.unauthorized('This account has been closed.', 'ACCOUNT_CLOSED');
    if (user.status === 'banned') {
      throw Errors.forbidden('This account has been banned. Contact support if you think this is a mistake.', 'ACCOUNT_BANNED');
    }
  }

  async refresh(refreshToken: string | undefined, meta: SessionMeta): Promise<AuthResult> {
    if (!refreshToken) throw Errors.unauthorized('Sign in again to continue.', 'INVALID_REFRESH_TOKEN');
    const { subjectId, family } = await this.tokens.rotate('user', refreshToken, meta);
    const user = await this.users.findById(subjectId);
    if (!user) throw Errors.unauthorized('Sign in again to continue.', 'INVALID_REFRESH_TOKEN');
    this.assertCanSignIn(user);
    const tokens = await this.tokens.issue('user', subjectId, user.tokenVersion ?? 0, meta, family);
    return { user: toPublicUser(user), tokens };
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.tokens.revoke('user', refreshToken);
  }

  /** Ends every session on every device, including access tokens already handed out. */
  async signOutEverywhere(user: AuthUser): Promise<void> {
    await this.users.update(user.id, { $inc: { tokenVersion: 1 } });
    await this.tokens.revokeAll('user', user.id);
  }

  private channelFor(identifier: string, requested?: OtpChannel): OtpChannel {
    if (requested) return requested;
    return looksLikeEmail(identifier) ? 'email' : 'sms';
  }

  private destination(user: Lean<User>, channel: OtpChannel): string {
    if (channel === 'email') return user.email;
    if (!user.phone) throw Errors.badRequest('There is no phone number on this account. Use email instead.', 'NO_PHONE');
    return user.phone;
  }

  /**
   * Sends a verify-email or reset-password code. A reset for an unknown
   * account still answers "sent" so the form cannot be used to discover
   * which emails are registered.
   */
  async sendOtp(input: SendOtpDto | (ForgotPasswordDto & { purpose: 'reset-password' })): Promise<IssuedOtp> {
    const channel = this.channelFor(input.identifier, input.channel);
    const user = await this.users.findByIdentifier(input.identifier);

    if (input.purpose === 'reset-password' && (!user || user.status === 'closed' || user.status === 'banned')) {
      return {
        sent: true,
        channel,
        sentTo: channel === 'email' ? 'your email' : 'your phone',
        expiresAt: new Date(Date.now() + this.config.otp.ttlSeconds * 1000).toISOString(),
        resendAt: new Date(Date.now() + this.config.otp.resendCooldownSeconds * 1000).toISOString(),
      };
    }
    if (!user) throw Errors.notFound('We could not find that account.', 'USER_NOT_FOUND');
    if (input.purpose === 'verify-email' && user.emailVerified) {
      throw Errors.conflict('This email address is already verified.', 'ALREADY_VERIFIED');
    }

    return this.otp.issue({
      key: AuthService.otpKey(user._id),
      purpose: input.purpose,
      channel,
      to: this.destination(user, channel),
      userId: String(user._id),
    });
  }

  async verifyOtp(input: VerifyOtpDto): Promise<{ verified: true; user?: PublicUser; resetToken?: string; resetTokenExpiresIn?: number }> {
    const user = await this.users.findByIdentifier(input.identifier);
    if (!user) throw Errors.badRequest('That code has expired. Request a new one.', 'OTP_EXPIRED');
    await this.otp.verify({ key: AuthService.otpKey(user._id), purpose: input.purpose, code: input.code });

    if (input.purpose === 'verify-email') {
      const updated = await this.users.update(String(user._id), { $set: { emailVerified: true } });
      if (!user.emailVerified) {
        void this.mail.send(updated.email, {
          subject: 'Welcome to DOOAA',
          heading: `Welcome, ${updated.firstName}!`,
          paragraphs: [
            'Your email is confirmed and your account is ready.',
            'Every purchase on DOOAA can be held in escrow until you confirm the item arrived as described — keep payments and chats on DOOAA so we can protect you.',
          ],
          cta: { label: 'Start exploring', url: this.config.clientUrl },
        });
      }
      return { verified: true, user: toPublicUser(updated) };
    }

    const ttl = 15 * 60;
    const payload: ResetTokenPayload = { sub: String(user._id), typ: 'reset', ver: user.tokenVersion ?? 0 };
    const resetToken = await this.jwt.signAsync(payload, { secret: this.resetSecret(), expiresIn: ttl, audience: 'dooaa-reset' });
    return { verified: true, resetToken, resetTokenExpiresIn: ttl };
  }

  private resetSecret(): string {
    return `${this.config.jwt.refreshSecret}:password-reset`;
  }

  /** Completes a reset. The token dies with the password it replaced (token version bump). */
  async resetPassword(resetToken: string, password: string): Promise<{ reset: true }> {
    let payload: ResetTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<ResetTokenPayload>(resetToken, { secret: this.resetSecret(), audience: 'dooaa-reset' });
    } catch {
      throw Errors.badRequest('This reset link has expired. Start again.', 'RESET_TOKEN_INVALID');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || payload.typ !== 'reset' || (user.tokenVersion ?? 0) !== payload.ver) {
      throw Errors.badRequest('This reset link has expired. Start again.', 'RESET_TOKEN_INVALID');
    }
    await this.users.setPassword(String(user._id), await this.passwords.hash(password));
    void this.mail.send(user.email, {
      subject: 'Your DOOAA password was changed',
      heading: 'Password changed',
      paragraphs: [
        `Hi ${user.firstName}, the password on your DOOAA account was just changed and you have been signed out everywhere.`,
        'If this was not you, reset your password immediately and contact support.',
      ],
    });
    return { reset: true };
  }

  /** Re-confirms the signed-in user's password before a sensitive action. */
  async verifyPassword(user: AuthUser, password: string): Promise<{ ok: true }> {
    const record = await this.userModel.findById(user.id).select('+passwordHash').lean();
    if (!(await this.passwords.verify(password, record?.passwordHash))) {
      throw Errors.badRequest('That password is incorrect.', 'INVALID_PASSWORD');
    }
    return { ok: true };
  }

  /**
   * The onboarding Preferences step. Anyone can become a seller; going back
   * to buyer is only allowed while the store has nothing live.
   */
  async setRole(user: AuthUser, role: UserRole): Promise<PublicUser> {
    if (user.role === role) return toPublicUser(await this.users.getById(user.id));
    if (user.role === 'seller' && role === 'buyer') {
      const record = await this.users.getById(user.id);
      if ((record.stats?.activeListings ?? 0) > 0) {
        throw Errors.conflict('Unpublish your listings before switching back to a buyer account.', 'SELLER_HAS_LISTINGS');
      }
    }
    return toPublicUser(await this.users.setRole(user.id, role));
  }

  async me(user: AuthUser): Promise<PublicUser> {
    return toPublicUser(await this.users.getById(user.id));
  }
}
