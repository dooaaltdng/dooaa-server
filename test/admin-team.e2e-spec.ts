import { createTestApp, type TestApp } from './utils/app';
import { Http, data, failure } from './utils/http';
import { PASSWORD, createStaff, registerUser, staffToken, uniqueEmail } from './utils/factories';

describe('Admin team, console auth and settings (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let superadmin: Awaited<ReturnType<typeof staffToken>>;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    superadmin = await staffToken(t, 'superadmin', { firstName: 'Nelson', lastName: 'Doe' });
  });
  afterAll(async () => t.close());

  describe('console sign-in', () => {
    it('returns the console session shape without the password', async () => {
      const member = await createStaff(t, 'moderator', { firstName: 'Amara', lastName: 'Eze' });
      const result = data(await http.post('/admin/auth/sign-in', { email: member.email.toUpperCase(), password: PASSWORD }));
      expect(result.session).toEqual({
        id: member.id,
        firstName: 'Amara',
        lastName: 'Eze',
        email: member.email,
        role: 'moderator',
        title: 'Moderator',
        avatar: null,
        online: false,
        status: 'active',
        lastSeenAt: expect.any(String),
      });
      expect(result.tokens.refreshToken).toMatch(/^s\./);
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('rejects wrong credentials with the console copy', async () => {
      const member = await createStaff(t, 'admin');
      const body = failure(await http.post('/admin/auth/sign-in', { email: member.email, password: 'Wrong@1234' }), 401, 'INVALID_CREDENTIALS');
      expect(body.error).toBe('Those credentials do not match a console account.');
    });

    it('refuses disabled members', async () => {
      const member = await createStaff(t, 'admin', { status: 'disabled' });
      failure(await http.post('/admin/auth/sign-in', { email: member.email, password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
    });

    it('keeps user and staff tokens apart', async () => {
      const user = await registerUser(t);
      failure(await http.get('/admin/auth/me', user.token), 401, 'INVALID_TOKEN');
      failure(await http.get('/auth/me', superadmin.token), 401, 'INVALID_TOKEN');
      expect(data(await http.get('/admin/auth/me', superadmin.token)).role).toBe('superadmin');
    });

    it('requires a token on console routes', async () => {
      failure(await http.get('/admin/staff'), 401, 'UNAUTHORIZED');
    });

    it('rotates console refresh tokens and signs out', async () => {
      const member = await staffToken(t, 'admin');
      const next = data(await http.post('/admin/auth/refresh', { refreshToken: member.refreshToken }));
      expect(next.tokens.refreshToken).not.toBe(member.refreshToken);
      failure(await http.post('/admin/auth/refresh', { refreshToken: member.refreshToken }), 401, 'REFRESH_TOKEN_REUSED');
      const fresh = await staffToken(t, 'admin');
      data(await http.post('/admin/auth/sign-out', { refreshToken: fresh.refreshToken }));
      failure(await http.post('/admin/auth/refresh', { refreshToken: fresh.refreshToken }), 401);
    });

    it('does not accept a user refresh token on the console', async () => {
      const user = await registerUser(t);
      failure(await http.post('/admin/auth/refresh', { refreshToken: user.refreshToken }), 401, 'INVALID_REFRESH_TOKEN');
    });
  });

  describe('team', () => {
    it('lists the team, superadmins first', async () => {
      const team = data(await http.get('/admin/staff', superadmin.token));
      expect(team[0].role).toBe('superadmin');
      expect(team.every((member: any) => !('passwordHash' in member))).toBe(true);
    });

    it('invites by email; the invitee sets a password and is signed in', async () => {
      const email = uniqueEmail('tunde');
      const invited = data(await http.post('/admin/staff/invite', { email, firstName: 'Tunde', lastName: 'Balogun', role: 'admin' }, superadmin.token));
      expect(invited).toMatchObject({ email, role: 'admin', status: 'invited' });

      await t.mail.idle();
      const mail = t.mail.lastTo(email)!;
      expect(mail.subject).toBe('You have been invited to the DOOAA console');
      const token = decodeURIComponent(mail.text.match(/token=([^\s]+)/)![1]);

      expect(data(await http.get(`/admin/auth/invite/${encodeURIComponent(token)}`))).toMatchObject({ email, role: 'admin' });
      const accepted = data(await http.post('/admin/auth/accept-invite', { token, password: 'Console#2025' }));
      expect(accepted.session).toMatchObject({ email, status: 'active' });
      failure(await http.post('/admin/auth/accept-invite', { token, password: 'Console#2025' }), 404, 'INVITE_INVALID');
      data(await http.post('/admin/auth/sign-in', { email, password: 'Console#2025' }));
    });

    it('only lets members with settings.manage invite', async () => {
      const admin = await staffToken(t, 'admin');
      failure(
        await http.post('/admin/staff/invite', { email: uniqueEmail(), firstName: 'Joy', lastName: 'Ekanem', role: 'moderator' }, admin.token),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('will not invite over an existing console account', async () => {
      const member = await createStaff(t, 'moderator');
      failure(
        await http.post('/admin/staff/invite', { email: member.email, firstName: 'Ada', lastName: 'Obi', role: 'admin' }, superadmin.token),
        409,
        'STAFF_EXISTS',
      );
    });

    it('rejects an unknown invitation token', async () => {
      failure(await http.get(`/admin/auth/invite/${'x'.repeat(40)}`), 404, 'INVITE_INVALID');
    });

    it('changes another member’s role, ending their sessions', async () => {
      const member = await staffToken(t, 'moderator');
      const updated = data(await http.patch(`/admin/staff/${member.id}/role`, { role: 'admin' }, superadmin.token));
      expect(updated).toMatchObject({ role: 'admin', title: 'Admin' });
      failure(await http.get('/admin/auth/me', member.token), 401, 'SESSION_REVOKED');
    });

    it('never lets you change your own role', async () => {
      failure(await http.patch(`/admin/staff/${superadmin.id}/role`, { role: 'admin' }, superadmin.token), 403, 'SELF_ROLE_CHANGE');
    });

    it('disables and restores a member', async () => {
      const member = await staffToken(t, 'moderator');
      expect(data(await http.post(`/admin/staff/${member.id}/disable`, {}, superadmin.token)).status).toBe('disabled');
      failure(await http.get('/admin/auth/me', member.token), 401, 'SESSION_REVOKED');
      failure(await http.post('/admin/auth/sign-in', { email: member.email, password: PASSWORD }), 401);
      expect(data(await http.post(`/admin/staff/${member.id}/restore`, {}, superadmin.token)).status).toBe('active');
      data(await http.post('/admin/auth/sign-in', { email: member.email, password: PASSWORD }));
    });

    it('cannot disable yourself', async () => {
      failure(await http.post(`/admin/staff/${superadmin.id}/disable`, {}, superadmin.token), 403, 'SELF_DISABLE');
    });

    it('404s on malformed ids', async () => {
      failure(await http.patch('/admin/staff/not-an-id/role', { role: 'admin' }, superadmin.token), 404);
    });

    it('records team changes in the audit log', async () => {
      const member = await staffToken(t, 'moderator', { firstName: 'Kelechi', lastName: 'Umeh' });
      data(await http.patch(`/admin/staff/${member.id}/role`, { role: 'admin' }, superadmin.token));
      const log = data(await http.get('/admin/audit?search=Kelechi', superadmin.token));
      expect(log.rows[0]).toMatchObject({ actor: 'Nelson Doe', action: "Changed a team member's role to Admin", target: 'Kelechi Umeh' });
      expect(log).toMatchObject({ page: 1, from: 1 });
    });
  });

  describe('settings', () => {
    const escrow = { enabled: true, feePercent: 0.8, minimumFee: 500, autoReleaseDays: 7, payoutMethods: ['Bank Transfer'] };

    it('returns every section and the permission vocabulary', async () => {
      const result = data(await http.get('/admin/settings', superadmin.token));
      expect(Object.keys(result.settings)).toEqual(
        expect.arrayContaining(['escrow', 'disputes', 'moderation', 'marketplace', 'notifications', 'roles', 'commerce']),
      );
      expect(result.superadminOnly).toEqual(['escrow.force', 'escrow.reverse']);
      expect(result.settings.roles.superadmin).toEqual(result.permissions);
    });

    it('saves a section, audits it and reflects it publicly', async () => {
      const saved = data(await http.put('/admin/settings/escrow', { value: escrow }, superadmin.token));
      expect(saved).toEqual({ section: 'escrow', value: escrow });
      expect(data(await http.get('/settings/public')).escrow.feePercent).toBe(0.8);
      const log = data(await http.get('/admin/audit?targetType=settings', superadmin.token));
      expect(log.rows[0].action).toBe('Changed the escrow fee (0.5% → 0.8%)');
    });

    it('validates section values strictly', async () => {
      failure(await http.put('/admin/settings/escrow', { value: { ...escrow, feePercent: -1 } }, superadmin.token), 400, 'VALIDATION_FAILED');
      failure(await http.put('/admin/settings/escrow', { value: { ...escrow, surprise: true } }, superadmin.token), 400, 'VALIDATION_FAILED');
      failure(await http.put('/admin/settings/nonsense', { value: {} }, superadmin.token), 400, 'VALIDATION_FAILED');
    });

    it('needs settings.manage to save', async () => {
      const moderator = await staffToken(t, 'moderator');
      failure(await http.put('/admin/settings/escrow', { value: escrow }, moderator.token), 403, 'PERMISSION_DENIED');
    });

    it('keeps the role matrix with superadmins and the elevated verbs locked', async () => {
      const roles = (await http.get('/admin/settings', superadmin.token)).body.data.settings.roles;
      failure(
        await http.put('/admin/settings/roles', { value: { ...roles, admin: [...roles.admin, 'escrow.force'] } }, superadmin.token),
        400,
        'SUPERADMIN_ONLY_PERMISSION',
      );

      // Grant admins settings.manage: they can then save sections, but not the matrix itself.
      data(await http.put('/admin/settings/roles', { value: { ...roles, superadmin: [], admin: [...roles.admin, 'settings.manage'] } }, superadmin.token));
      const after = data(await http.get('/admin/settings', superadmin.token)).settings.roles;
      expect(after.superadmin.length).toBeGreaterThan(5);
      const admin = await staffToken(t, 'admin');
      data(await http.put('/admin/settings/escrow', { value: escrow }, admin.token));
      failure(await http.put('/admin/settings/roles', { value: after }, admin.token), 403, 'SUPERADMIN_REQUIRED');

      // Taking it away again takes effect immediately.
      data(await http.put('/admin/settings/roles', { value: roles }, superadmin.token));
      failure(await http.put('/admin/settings/escrow', { value: escrow }, admin.token), 403, 'PERMISSION_DENIED');
    });
  });
});
