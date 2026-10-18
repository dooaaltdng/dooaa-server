import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import { STAFF_ROLE_LABEL, type StaffRole } from '../../common/domain';
import { normalizeEmail } from '../../common/util/text';
import { isUuid } from '../../common/util/uuid';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { InjectDb, type Database } from '../../database/database';
import { staff } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { PrincipalService } from '../auth/principal.service';
import { TokenService, type SessionMeta, type TokenPair } from '../auth/token.service';
import { MailService } from '../mail/mail.service';
import { PasswordService } from '../users/password.service';
import { PRESENCE, PresenceRegistry } from './presence';
import { staffColumns, type StaffMember } from './staff.model';
import { toStaffSession, type StaffSession } from './staff.presenter';

const INVITE_TTL_DAYS = 7;

function hashInvite(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class StaffService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    @Inject(PRESENCE) private readonly presence: PresenceRegistry,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  private session(member: StaffMember): StaffSession {
    return toStaffSession(member, this.presence.isOnline(member.id));
  }

  /** A live invitation or reset link, by its token. */
  private async byLinkToken(token: string): Promise<StaffMember | null> {
    const [member] = await this.db
      .select(staffColumns)
      .from(staff)
      .where(and(eq(staff.inviteTokenHash, hashInvite(token)), inArray(staff.status, ['invited', 'active']), gt(staff.inviteExpiresAt, new Date())));
    return member ?? null;
  }

  async signIn(email: string, password: string, meta: SessionMeta): Promise<{ session: StaffSession; tokens: TokenPair }> {
    const [member] = await this.db
      .select({ ...staffColumns, passwordHash: staff.passwordHash })
      .from(staff)
      .where(eq(staff.email, normalizeEmail(email)));
    if (member?.lockedUntil && member.lockedUntil.getTime() > Date.now()) {
      throw Errors.tooMany('Too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
    }
    const valid = await this.passwords.verify(password, member?.passwordHash);
    if (!member || !valid || member.status !== 'active') {
      if (member && !valid) {
        const [updated] = await this.db
          .update(staff)
          .set({ failedSignIns: sql`${staff.failedSignIns} + 1` })
          .where(eq(staff.id, member.id))
          .returning({ failedSignIns: staff.failedSignIns });
        if (updated && updated.failedSignIns >= this.config.auth.maxFailedSignIns) {
          await this.db
            .update(staff)
            .set({ lockedUntil: new Date(Date.now() + this.config.auth.lockMinutes * 60_000), failedSignIns: 0 })
            .where(eq(staff.id, member.id));
        }
      }
      throw Errors.unauthorized('Those credentials do not match a console account.', 'INVALID_CREDENTIALS');
    }
    const now = new Date();
    const [signedIn] = await this.db
      .update(staff)
      .set({ lastLoginAt: now, lastSeenAt: now, failedSignIns: 0, lockedUntil: null })
      .where(eq(staff.id, member.id))
      .returning(staffColumns);
    const tokens = await this.tokens.issue('staff', member.id, member.tokenVersion, meta);
    return { session: this.session(signedIn), tokens };
  }

  async refresh(refreshToken: string | undefined, meta: SessionMeta): Promise<{ session: StaffSession; tokens: TokenPair }> {
    if (!refreshToken) throw Errors.unauthorized('Sign in again to continue.', 'INVALID_REFRESH_TOKEN');
    const { subjectId, family } = await this.tokens.rotate('staff', refreshToken, meta);
    const member = await this.findById(subjectId);
    if (!member || member.status !== 'active') throw Errors.unauthorized('Sign in again to continue.', 'INVALID_REFRESH_TOKEN');
    const tokens = await this.tokens.issue('staff', subjectId, member.tokenVersion, meta, family);
    return { session: this.session(member), tokens };
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.tokens.revoke('staff', refreshToken);
  }

  async me(actor: AuthStaff): Promise<StaffSession> {
    const member = await this.findById(actor.id);
    if (!member) throw Errors.unauthorized();
    return this.session(member);
  }

  /** The whole team: active and invited members by seniority, then anyone removed (so they can be restored). */
  async list(): Promise<StaffSession[]> {
    const members = await this.db.select(staffColumns).from(staff).orderBy(asc(staff.createdAt));
    const rank: Record<StaffRole, number> = { superadmin: 0, admin: 1, moderator: 2 };
    const removed = (member: StaffMember) => (member.status === 'disabled' ? 1 : 0);
    return members.sort((a, b) => removed(a) - removed(b) || rank[a.role] - rank[b.role]).map((member) => this.session(member));
  }

  async findById(id: string): Promise<StaffMember | null> {
    if (!isUuid(id)) return null;
    const [member] = await this.db.select(staffColumns).from(staff).where(eq(staff.id, id));
    return member ?? null;
  }

  async activeSuperadmins(): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(staff)
      .where(and(eq(staff.role, 'superadmin'), eq(staff.status, 'active')));
    return row.total;
  }

  /** All active staff, for fan-out notifications. */
  async activeMembers(): Promise<StaffMember[]> {
    return this.db.select(staffColumns).from(staff).where(eq(staff.status, 'active'));
  }

  async invite(actor: AuthStaff, input: { email: string; firstName: string; lastName: string; role: StaffRole; title?: string }): Promise<StaffSession & { inviteExpiresAt: string }> {
    if (input.role === 'superadmin' && actor.role !== 'superadmin') {
      throw Errors.forbidden('Only a superadmin can invite another superadmin.', 'SUPERADMIN_REQUIRED');
    }
    const email = normalizeEmail(input.email);
    const [existing] = await this.db.select({ status: staff.status }).from(staff).where(eq(staff.email, email));
    if (existing && existing.status !== 'invited') {
      throw Errors.conflict('That email already has a console account.', 'STAFF_EXISTS');
    }
    const token = randomBytes(32).toString('base64url');
    const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
    const invitation = {
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      title: input.title || STAFF_ROLE_LABEL[input.role],
      status: 'invited' as const,
      inviteTokenHash: hashInvite(token),
      inviteExpiresAt,
      invitedBy: actor.id,
    };
    // Inviting the same address again replaces the earlier (unaccepted) invitation.
    const [member] = await this.db
      .insert(staff)
      .values({ email, ...invitation })
      .onConflictDoUpdate({ target: staff.email, set: invitation, setWhere: eq(staff.status, 'invited') })
      .returning(staffColumns);
    if (!member) throw Errors.conflict('That email already has a console account.', 'STAFF_EXISTS');
    const link = `${this.config.adminUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    void this.mail.send(email, {
      subject: 'You have been invited to the DOOAA console',
      heading: `Join the DOOAA team, ${input.firstName}`,
      paragraphs: [
        `${actor.firstName} ${actor.lastName} invited you to the DOOAA management console as ${STAFF_ROLE_LABEL[input.role].toLowerCase()}.`,
        `Set a password to activate your account. The invitation expires in ${INVITE_TTL_DAYS} days.`,
      ],
      cta: { label: 'Accept invitation', url: link },
    });
    await this.audit.record(actor, {
      action: `Invited a ${STAFF_ROLE_LABEL[input.role].toLowerCase()}`,
      target: `${input.firstName} ${input.lastName} (${email})`,
      targetType: 'staff',
      targetId: member.id,
      elevated: input.role === 'superadmin',
    });
    return { ...this.session(member), inviteExpiresAt: inviteExpiresAt.toISOString() };
  }

  /**
   * What the set-password page shows for a link: an invitation (status
   * invited) or a password reset the platform team sent an active member.
   */
  async inviteInfo(token: string): Promise<{ email: string; firstName: string; lastName: string; role: StaffRole; purpose: 'invite' | 'reset' }> {
    const member = await this.byLinkToken(token);
    if (!member) throw Errors.notFound('This link is no longer valid. Ask a superadmin for a new one.', 'INVITE_INVALID');
    return {
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      role: member.role,
      purpose: member.status === 'invited' ? 'invite' : 'reset',
    };
  }

  /**
   * Sets the password from an invitation or a reset link, and signs the member
   * in. A reset also ends every other session, since the old password may be
   * the reason for it.
   */
  async acceptInvite(token: string, password: string, meta: SessionMeta): Promise<{ session: StaffSession; tokens: TokenPair }> {
    const current = await this.byLinkToken(token);
    if (!current) throw Errors.notFound('This link is no longer valid. Ask a superadmin for a new one.', 'INVITE_INVALID');
    const reset = current.status === 'active';
    const [member] = await this.db
      .update(staff)
      .set({
        status: 'active',
        passwordHash: await this.passwords.hash(password),
        lastLoginAt: new Date(),
        failedSignIns: 0,
        inviteTokenHash: null,
        inviteExpiresAt: null,
        lockedUntil: null,
        ...(reset ? { tokenVersion: sql`${staff.tokenVersion} + 1` } : {}),
      })
      .where(and(eq(staff.id, current.id), eq(staff.inviteTokenHash, hashInvite(token))))
      .returning(staffColumns);
    if (!member) throw Errors.notFound('This link is no longer valid. Ask a superadmin for a new one.', 'INVITE_INVALID');
    if (reset) {
      await this.principals.invalidateStaff(member.id);
      await this.tokens.revokeAll('staff', member.id);
      await this.audit.record(
        { kind: 'system', name: `${member.firstName} ${member.lastName}` },
        { action: 'Set a new console password from a reset link', target: member.email, targetType: 'staff', targetId: member.id },
      );
    }
    const tokens = await this.tokens.issue('staff', member.id, member.tokenVersion, meta);
    return { session: this.session(member), tokens };
  }

  /**
   * "Send password reset": the console has no self-service reset, so the
   * platform team sends a one-time link (valid for a day) to set a new one.
   */
  async sendPasswordReset(actor: AuthStaff, id: string): Promise<{ id: string; resetExpiresAt: string }> {
    const member = await this.findById(id);
    if (!member || member.status === 'disabled') throw Errors.notFound('That team member is not on the console.', 'STAFF_NOT_FOUND');
    if (member.status === 'invited') throw Errors.conflict('This member has not accepted their invitation yet. Send the invitation again instead.', 'STAFF_INVITED');
    if (member.role === 'superadmin' && actor.role !== 'superadmin') {
      throw Errors.forbidden("Only a superadmin can reset a superadmin's password.", 'SUPERADMIN_REQUIRED');
    }
    const token = randomBytes(32).toString('base64url');
    const resetExpiresAt = new Date(Date.now() + 86_400_000);
    await this.db.update(staff).set({ inviteTokenHash: hashInvite(token), inviteExpiresAt: resetExpiresAt }).where(eq(staff.id, member.id));
    const link = `${this.config.adminUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    void this.mail.send(member.email, {
      subject: 'Reset your DOOAA console password',
      heading: 'Set a new console password',
      paragraphs: [
        `Hi ${member.firstName}, ${actor.firstName} ${actor.lastName} sent you a link to set a new password for the DOOAA console.`,
        'The link works once and expires in 24 hours. Setting a new password signs you out everywhere else.',
        'If you did not ask for this, tell your team lead.',
      ],
      cta: { label: 'Set a new password', url: link },
    });
    await this.audit.record(actor, {
      action: 'Sent a password reset to a team member',
      target: `${member.firstName} ${member.lastName}`,
      targetType: 'staff',
      targetId: id,
    });
    return { id, resetExpiresAt: resetExpiresAt.toISOString() };
  }

  /** Changing your own password from the account menu. Other sessions end; this one carries on with fresh tokens. */
  async changePassword(actor: AuthStaff, currentPassword: string, newPassword: string, meta: SessionMeta): Promise<{ session: StaffSession; tokens: TokenPair }> {
    const [member] = await this.db
      .select({ email: staff.email, passwordHash: staff.passwordHash })
      .from(staff)
      .where(eq(staff.id, actor.id));
    if (!member) throw Errors.unauthorized();
    if (!(await this.passwords.verify(currentPassword, member.passwordHash))) {
      throw Errors.badRequest('Your current password is not correct.', 'WRONG_PASSWORD');
    }
    if (await this.passwords.verify(newPassword, member.passwordHash)) {
      throw Errors.badRequest('Choose a password you have not used here before.', 'PASSWORD_REUSED');
    }
    const [updated] = await this.db
      .update(staff)
      .set({ passwordHash: await this.passwords.hash(newPassword), tokenVersion: sql`${staff.tokenVersion} + 1` })
      .where(eq(staff.id, actor.id))
      .returning(staffColumns);
    await this.principals.invalidateStaff(actor.id);
    await this.tokens.revokeAll('staff', actor.id);
    await this.audit.record(actor, { action: 'Changed their console password', target: member.email, targetType: 'staff', targetId: actor.id });
    const tokens = await this.tokens.issue('staff', actor.id, updated.tokenVersion, meta);
    return { session: this.session(updated), tokens };
  }

  /**
   * Changing a seat. Nobody changes their own role, only a superadmin can
   * grant or take away superadmin, and the last superadmin stays one.
   */
  async updateRole(actor: AuthStaff, id: string, role: StaffRole): Promise<StaffSession> {
    if (actor.id === id) throw Errors.forbidden('You cannot change your own role.', 'SELF_ROLE_CHANGE');
    const member = await this.findById(id);
    if (!member || member.status === 'disabled') throw Errors.notFound('That team member is not on the console.', 'STAFF_NOT_FOUND');
    const touchesSuperadmin = role === 'superadmin' || member.role === 'superadmin';
    if (touchesSuperadmin && actor.role !== 'superadmin') {
      throw Errors.forbidden('Only a superadmin can grant or remove superadmin.', 'SUPERADMIN_REQUIRED');
    }
    if (member.role === 'superadmin' && role !== 'superadmin' && (await this.activeSuperadmins()) <= 1) {
      throw Errors.conflict('The console needs at least one superadmin.', 'LAST_SUPERADMIN');
    }
    if (member.role === role) return this.session(member);
    const [updated] = await this.db
      .update(staff)
      .set({ role, title: STAFF_ROLE_LABEL[role], tokenVersion: sql`${staff.tokenVersion} + 1` })
      .where(eq(staff.id, id))
      .returning(staffColumns);
    await this.principals.invalidateStaff(id);
    await this.tokens.revokeAll('staff', id);
    await this.audit.record(actor, {
      action: `Changed a team member's role to ${STAFF_ROLE_LABEL[role]}`,
      target: `${member.firstName} ${member.lastName}`,
      targetType: 'staff',
      targetId: id,
      elevated: role === 'superadmin' || member.role === 'superadmin',
      meta: { from: member.role, to: role },
    });
    return this.session(updated);
  }

  async setDisabled(actor: AuthStaff, id: string, disabled: boolean): Promise<StaffSession> {
    if (actor.id === id) throw Errors.forbidden('You cannot remove yourself from the console.', 'SELF_DISABLE');
    const member = await this.findById(id);
    if (!member) throw Errors.notFound('That team member is not on the console.', 'STAFF_NOT_FOUND');
    if (member.role === 'superadmin') {
      if (actor.role !== 'superadmin') throw Errors.forbidden('Only a superadmin can remove a superadmin.', 'SUPERADMIN_REQUIRED');
      if (disabled && member.status === 'active' && (await this.activeSuperadmins()) <= 1) {
        throw Errors.conflict('The console needs at least one superadmin.', 'LAST_SUPERADMIN');
      }
    }
    // A restored member who never finished their invitation goes back to waiting on it.
    const status = disabled ? 'disabled' : member.lastLoginAt ? 'active' : 'invited';
    const [updated] = await this.db
      .update(staff)
      .set({ status, tokenVersion: sql`${staff.tokenVersion} + 1` })
      .where(eq(staff.id, id))
      .returning(staffColumns);
    await this.principals.invalidateStaff(id);
    await this.tokens.revokeAll('staff', id);
    await this.audit.record(actor, {
      action: disabled ? 'Removed a team member from the console' : 'Restored a team member',
      target: `${member.firstName} ${member.lastName}`,
      targetType: 'staff',
      targetId: id,
    });
    return this.session(updated);
  }

  async touch(id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.db.update(staff).set({ lastSeenAt: new Date() }).where(eq(staff.id, id));
  }

  /** Creates the first superadmin from configuration (seeding). An existing account is left as it is. */
  async ensureSuperadmin(input: { email: string; firstName: string; lastName: string; password: string }): Promise<StaffMember> {
    const email = normalizeEmail(input.email);
    const [existing] = await this.db.select(staffColumns).from(staff).where(eq(staff.email, email));
    if (existing) return existing;
    const [created] = await this.db
      .insert(staff)
      .values({
        email,
        firstName: input.firstName,
        lastName: input.lastName,
        role: 'superadmin',
        title: 'Superadmin',
        status: 'active',
        passwordHash: await this.passwords.hash(input.password),
      })
      .returning(staffColumns);
    return created;
  }
}
