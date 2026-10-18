import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import { type OtpChannel, regionFor } from '../../common/domain';
import { normalizePhone } from '../../common/util/text';
import { users } from '../../database/schema';
import { TokenService, type SessionMeta, type TokenPair } from '../auth/token.service';
import { MailService } from '../mail/mail.service';
import { MediaService } from '../media/media.service';
import { OtpService, type IssuedOtp } from '../otp/otp.service';
import { ACCOUNT_EVENTS, type AccountClosed, type AccountClosing } from './account.events';
import type { NotificationPrefsDto, UpdateProfileDto } from './dto/me.dto';
import { PasswordService } from './password.service';
import type { UserStats } from './user.model';
import { toPublicUser, type PublicUser } from './user.presenter';
import { UsersService, type UserPatch } from './users.service';

@Injectable()
export class MeService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly media: MediaService,
    private readonly mail: MailService,
    private readonly events: EventBus,
  ) {}

  async profile(user: AuthUser): Promise<PublicUser & { stats: UserStats }> {
    const record = await this.users.getById(user.id);
    return { ...toPublicUser(record), stats: record.stats };
  }

  async update(user: AuthUser, input: UpdateProfileDto): Promise<PublicUser> {
    const patch: UserPatch = {};
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName;
    if (input.gender !== undefined) patch.gender = input.gender;
    if (input.location !== undefined) {
      patch.location = input.location;
      patch.region = regionFor(input.location) ?? null;
    }
    if (input.phone !== undefined) {
      const phone = normalizePhone(input.phone);
      if (phone !== user.phone) {
        patch.phone = phone;
        patch.phoneVerified = false;
      }
    }
    if (input.storeName !== undefined) patch.sellerStoreName = input.storeName;
    if (input.dispatchDays !== undefined) patch.sellerDispatchDays = input.dispatchDays;
    if (input.responseLabel !== undefined) patch.sellerResponseLabel = input.responseLabel;
    if (input.deliveryLabel !== undefined) patch.sellerDeliveryLabel = input.deliveryLabel;
    if (!Object.keys(patch).length) return toPublicUser(await this.users.getById(user.id));
    return toPublicUser(await this.users.update(user.id, patch));
  }

  /** The profile photo: an image already uploaded through the media endpoint. */
  async setAvatar(user: AuthUser, url: string): Promise<PublicUser> {
    await this.media.assertOwnedUrls([url], { id: user.id, type: 'user' }, ['avatar']);
    return toPublicUser(await this.users.update(user.id, { avatarUrl: url }));
  }

  async removeAvatar(user: AuthUser): Promise<PublicUser> {
    return toPublicUser(await this.users.update(user.id, { avatarUrl: null }));
  }

  async setNotificationPrefs(user: AuthUser, input: NotificationPrefsDto): Promise<PublicUser['notificationPrefs']> {
    const changes: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(input)) if (typeof value === 'boolean') changes[key] = value;
    const updated = Object.keys(changes).length
      ? await this.users.update(user.id, { $set: Object.fromEntries(Object.entries(changes).map(([key, value]) => [`notificationPrefs.${key}`, value])) })
      : await this.users.getById(user.id);
    return toPublicUser(updated).notificationPrefs;
  }

  /** Step one of Change Password: a code to the email (or phone) on file. */
  async sendPasswordCode(user: AuthUser, channel: OtpChannel = 'email'): Promise<IssuedOtp> {
    const to = channel === 'email' ? user.email : user.phone;
    if (!to) throw Errors.badRequest('There is no phone number on this account. Use email instead.', 'NO_PHONE');
    return this.otp.issue({ key: `user:${user.id}`, purpose: 'change-password', channel, to, userId: user.id });
  }

  /**
   * Changes the password with both the emailed code and the current
   * password, ends every other session and hands this device a fresh pair.
   */
  async changePassword(user: AuthUser, input: { currentPassword: string; newPassword: string; code: string }, meta: SessionMeta): Promise<{ changed: true; tokens: TokenPair }> {
    if (!(await this.passwords.verify(input.currentPassword, await this.users.passwordHashOf(user.id)))) {
      throw Errors.badRequest('Your current password is incorrect.', 'INVALID_PASSWORD');
    }
    if (input.currentPassword === input.newPassword) {
      throw Errors.badRequest('Choose a password you have not used here before.', 'PASSWORD_UNCHANGED');
    }
    await this.otp.verify({ key: `user:${user.id}`, purpose: 'change-password', code: input.code });
    await this.users.setPassword(user.id, await this.passwords.hash(input.newPassword));
    const fresh = await this.users.getById(user.id);
    void this.mail.send(fresh.email, {
      subject: 'Your DOOAA password was changed',
      heading: 'Password changed',
      paragraphs: [
        `Hi ${fresh.firstName}, the password on your DOOAA account was just changed. Other devices have been signed out.`,
        'If this was not you, reset your password immediately and contact support.',
      ],
    });
    return { changed: true, tokens: await this.tokens.issue('user', user.id, fresh.tokenVersion, meta) };
  }

  /** Close Account. Other modules can veto (open orders, held funds) before anything changes. */
  async close(user: AuthUser, input: { reason: string; notes?: string; password: string }): Promise<{ closed: true }> {
    if (!(await this.passwords.verify(input.password, await this.users.passwordHashOf(user.id)))) {
      throw Errors.badRequest('That password is incorrect.', 'INVALID_PASSWORD');
    }
    await this.events.emit<AccountClosing>(ACCOUNT_EVENTS.closing, { userId: user.id });
    await this.users.update(user.id, { closedAt: new Date(), closeReason: input.reason, closeNotes: input.notes ?? null });
    const closed = await this.users.setStatus(user.id, 'closed', 'Closed by the account holder');
    await this.events.emit<AccountClosed>(ACCOUNT_EVENTS.closed, { userId: user.id, email: closed.email, firstName: closed.firstName });
    void this.mail.send(closed.email, {
      subject: 'Your DOOAA account has been closed',
      heading: 'Account closed',
      paragraphs: [
        `Hi ${closed.firstName}, your DOOAA account is closed and you have been signed out everywhere.`,
        'Thank you for the time you spent with us. If you change your mind, contact support and we will help.',
      ],
    });
    return { closed: true };
  }
}
