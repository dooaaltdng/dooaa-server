import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createTestApp, type TestApp } from './utils/app';
import { API, Http, data, failure } from './utils/http';
import { PASSWORD, codeFromMail, codeFromSms, model, registerUser, uniqueEmail, uniquePhone } from './utils/factories';
import { User } from '../src/modules/users/schemas/user.schema';
import { UsersService } from '../src/modules/users/users.service';

describe('Auth (e2e)', () => {
  let t: TestApp;
  let http: Http;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
  });
  afterAll(async () => t.close());

  const signUpBody = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Nelson',
    lastName: 'Okafor',
    email: uniqueEmail('nelson'),
    phone: uniquePhone(),
    password: PASSWORD,
    acceptedTerms: true,
    acceptedPrivacy: true,
    ...overrides,
  });

  describe('platform', () => {
    it('reports health with the database up', async () => {
      const body = data(await http.get('/health'));
      expect(body).toMatchObject({ status: 'ok', db: 'up' });
    });

    it('answers unknown routes with the failure envelope', async () => {
      const body = failure(await http.get('/does-not-exist'), 404, 'NOT_FOUND');
      expect(body.error).toBe('We could not find that.');
    });

    it('sets security headers', async () => {
      const response = await http.get('/health');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('sign up', () => {
    it('creates an unverified account, returns tokens and mails a code', async () => {
      const body = signUpBody();
      const result = data(await http.post('/auth/sign-up', body), 201);
      expect(result.user).toMatchObject({
        firstName: 'Nelson',
        lastName: 'Okafor',
        email: body.email,
        role: null,
        verified: false,
        identity: 'unverified',
        status: 'active',
      });
      expect(result.user.phone).toMatch(/^\+234\d{10}$/);
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens.accessToken).toEqual(expect.any(String));
      expect(result.tokens.refreshToken).toMatch(/^u\./);
      expect(result.verification).toMatchObject({ sent: true, channel: 'email' });
      expect(result.verification.sentTo).toContain('•');
      expect(await codeFromMail(t, body.email)).toMatch(/^\d{6}$/);
    });

    it('stores a bcrypt hash, never the password', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const stored = await model<User>(t, User.name).findOne({ email: body.email }).select('+passwordHash').lean();
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(stored?.passwordHash).not.toContain(PASSWORD);
      expect(stored?.termsAcceptedAt).toBeInstanceOf(Date);
    });

    it('rejects a duplicate email regardless of case', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const again = failure(await http.post('/auth/sign-up', { ...body, email: body.email.toUpperCase() }), 409, 'EMAIL_TAKEN');
      expect(again.error).toBe('An account with that email already exists.');
    });

    it.each([
      [{ password: 'short1!' }, 'Password must be 8+ characters.'],
      [{ password: 'longenoughpassword' }, 'Include letters, numbers & symbols.'],
      [{ email: 'not-an-email' }, 'Enter a valid email address.'],
      [{ firstName: 'A' }, 'First name must be at least 2 characters.'],
      [{ phone: '12345' }, 'Enter a valid phone number.'],
      [{ acceptedTerms: false }, 'Accept the Terms & conditions to continue.'],
      [{ acceptedPrivacy: false }, 'Accept the Privacy Policy to continue.'],
    ])('validates %o', async (override, message) => {
      const body = failure(await http.post('/auth/sign-up', signUpBody(override)), 400, 'VALIDATION_FAILED');
      expect(body.error).toBe(message);
      expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ messages: expect.arrayContaining([message]) })]));
    });

    it('refuses fields it does not know (no role or status smuggling)', async () => {
      const body = failure(await http.post('/auth/sign-up', signUpBody({ role: 'seller', status: 'active' })), 400, 'VALIDATION_FAILED');
      expect(body.error).toMatch(/should not exist/);
    });

    it('refuses operator injection in place of strings', async () => {
      failure(await http.post('/auth/sign-in', { email: { $gt: '' }, password: { $gt: '' } }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('email verification', () => {
    it('confirms the email with the mailed code and sends a welcome email', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const code = await codeFromMail(t, body.email);
      const result = data(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code }));
      expect(result.verified).toBe(true);
      expect(result.user.verified).toBe(true);
      await t.mail.idle();
      expect(t.mail.lastTo(body.email)?.subject).toBe('Welcome to DOOAA');
    });

    it('rejects a wrong code and reports attempts left', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const code = await codeFromMail(t, body.email);
      const wrong = code === '000000' ? '111111' : '000000';
      const result = failure(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code: wrong }), 400, 'OTP_INVALID');
      expect(result.details.attemptsLeft).toBe(4);
    });

    it('locks the code after too many wrong attempts', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const code = await codeFromMail(t, body.email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        failure(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code: wrong }), 400, 'OTP_INVALID');
      }
      failure(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code }), 429, 'OTP_LOCKED');
    });

    it('does not accept a code twice', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const code = await codeFromMail(t, body.email);
      data(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code }));
      failure(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code }), 400, 'OTP_EXPIRED');
    });

    it('enforces a resend cooldown', async () => {
      const body = signUpBody();
      data(await http.post('/auth/sign-up', body));
      const result = failure(await http.post('/auth/otp/send', { purpose: 'verify-email', identifier: body.email }), 429, 'OTP_COOLDOWN');
      expect(result.details.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('can deliver the code by SMS to the phone on file', async () => {
      const t2 = await createTestApp({ env: { OTP_RESEND_COOLDOWN_SECONDS: '0' } });
      try {
        const http2 = new Http(t2);
        const body = signUpBody();
        data(await http2.post('/auth/sign-up', body));
        const sent = data(await http2.post('/auth/otp/send', { purpose: 'verify-email', identifier: body.email, channel: 'sms' }));
        expect(sent.channel).toBe('sms');
        expect(sent.sentTo).toMatch(/^\+234 ••• ••• \d{4}$/);
        const code = await codeFromSms(t2, body.phone);
        const result = data(await http2.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code }));
        expect(result.user.verified).toBe(true);
      } finally {
        await t2.close();
      }
    });

    it('a new code replaces the old one', async () => {
      const t2 = await createTestApp({ env: { OTP_RESEND_COOLDOWN_SECONDS: '0' } });
      try {
        const http2 = new Http(t2);
        const body = signUpBody();
        data(await http2.post('/auth/sign-up', body));
        const first = await codeFromMail(t2, body.email);
        data(await http2.post('/auth/otp/send', { purpose: 'verify-email', identifier: body.email }));
        const second = await codeFromMail(t2, body.email);
        if (first !== second) {
          failure(await http2.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code: first }), 400, 'OTP_INVALID');
        }
        data(await http2.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code: second }));
      } finally {
        await t2.close();
      }
    });

    it('refuses to re-verify an already verified email', async () => {
      const user = await registerUser(t);
      failure(await http.post('/auth/otp/send', { purpose: 'verify-email', identifier: user.email }), 409, 'ALREADY_VERIFIED');
    });

    it('accepts the development code only when one is configured', async () => {
      const t2 = await createTestApp({ env: { OTP_DEV_CODE: '123456' } });
      try {
        const http2 = new Http(t2);
        const body = signUpBody();
        data(await http2.post('/auth/sign-up', body));
        const result = data(await http2.post('/auth/otp/verify', { purpose: 'verify-email', identifier: body.email, code: '123456' }));
        expect(result.user.verified).toBe(true);
      } finally {
        await t2.close();
      }
    });
  });

  describe('sign in', () => {
    it('signs in case-insensitively and records the login', async () => {
      const user = await registerUser(t);
      const result = data(await http.post('/auth/sign-in', { email: user.email.toUpperCase(), password: PASSWORD }));
      expect(result.user.email).toBe(user.email);
      expect(result.tokens.accessToken).toEqual(expect.any(String));
      const stored = await model<User>(t, User.name).findById(user.id).lean();
      expect(stored?.lastLoginAt).toBeInstanceOf(Date);
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const user = await registerUser(t);
      const wrong = failure(await http.post('/auth/sign-in', { email: user.email, password: 'Wrong@1234' }), 401, 'INVALID_CREDENTIALS');
      const unknown = failure(await http.post('/auth/sign-in', { email: uniqueEmail(), password: 'Wrong@1234' }), 401, 'INVALID_CREDENTIALS');
      expect(wrong.error).toBe('Incorrect email or password.');
      expect(unknown.error).toBe(wrong.error);
    });

    it('locks the account after repeated failures, even for the right password', async () => {
      const user = await registerUser(t);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        failure(await http.post('/auth/sign-in', { email: user.email, password: 'Wrong@1234' }), 401);
      }
      failure(await http.post('/auth/sign-in', { email: user.email, password: 'Wrong@1234' }), 429, 'ACCOUNT_LOCKED');
      failure(await http.post('/auth/sign-in', { email: user.email, password: PASSWORD }), 429, 'ACCOUNT_LOCKED');
    });

    it('refuses banned and closed accounts', async () => {
      const banned = await registerUser(t);
      const closed = await registerUser(t);
      await model<User>(t, User.name).updateOne({ _id: banned.id }, { $set: { status: 'banned' } });
      await model<User>(t, User.name).updateOne({ _id: closed.id }, { $set: { status: 'closed' } });
      failure(await http.post('/auth/sign-in', { email: banned.email, password: PASSWORD }), 403, 'ACCOUNT_BANNED');
      failure(await http.post('/auth/sign-in', { email: closed.email, password: PASSWORD }), 401, 'ACCOUNT_CLOSED');
    });
  });

  describe('sessions', () => {
    it('requires a token for account routes', async () => {
      failure(await http.get('/auth/me'), 401, 'UNAUTHORIZED');
      failure(await http.get('/auth/me', 'not-a-jwt'), 401, 'INVALID_TOKEN');
    });

    it('returns the signed-in account', async () => {
      const user = await registerUser(t);
      const me = data(await http.get('/auth/me', user.token));
      expect(me).toMatchObject({ id: user.id, email: user.email, role: 'buyer', verified: true });
    });

    it('reports an expired access token distinctly so the app can refresh', async () => {
      const user = await registerUser(t);
      const jwt = t.get<JwtService>(JwtService);
      const expired = jwt.sign(
        { sub: user.id, typ: 'user', ver: 0, exp: Math.floor(Date.now() / 1000) - 30 },
        { secret: process.env.JWT_ACCESS_SECRET, issuer: 'dooaa', audience: 'dooaa-client' },
      );
      failure(await http.get('/auth/me', expired), 401, 'TOKEN_EXPIRED');
    });

    it('rotates refresh tokens and detects reuse', async () => {
      const user = await registerUser(t);
      const first = data(await http.post('/auth/refresh', { refreshToken: user.refreshToken }));
      expect(first.tokens.refreshToken).not.toBe(user.refreshToken);
      data(await http.get('/auth/me', first.tokens.accessToken));

      // Replaying the rotated token revokes the whole sign-in, including the new token.
      failure(await http.post('/auth/refresh', { refreshToken: user.refreshToken }), 401, 'REFRESH_TOKEN_REUSED');
      failure(await http.post('/auth/refresh', { refreshToken: first.tokens.refreshToken }), 401, 'REFRESH_TOKEN_REUSED');
    });

    it('refreshes from the httpOnly cookie', async () => {
      const body = signUpBody();
      const response = await request(t.server).post(`${API}/auth/sign-up`).send(body);
      const cookie = ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((value) => value.startsWith('dooaa_rt='));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      const refreshed = await request(t.server).post(`${API}/auth/refresh`).set('Cookie', cookie!.split(';')[0]).send({});
      expect(data(refreshed).user.email).toBe(body.email);
    });

    it('signs out one session', async () => {
      const user = await registerUser(t);
      data(await http.post('/auth/sign-out', { refreshToken: user.refreshToken }));
      failure(await http.post('/auth/refresh', { refreshToken: user.refreshToken }), 401, 'REFRESH_TOKEN_REUSED');
    });

    it('signs out everywhere, voiding access tokens too', async () => {
      const user = await registerUser(t);
      const other = data(await http.post('/auth/sign-in', { email: user.email, password: PASSWORD }));
      data(await http.post('/auth/sign-out-all', {}, user.token));
      failure(await http.get('/auth/me', user.token), 401, 'SESSION_REVOKED');
      failure(await http.get('/auth/me', other.tokens.accessToken), 401, 'SESSION_REVOKED');
      failure(await http.post('/auth/refresh', { refreshToken: other.tokens.refreshToken }), 401);
    });

    it('locks a banned account out immediately', async () => {
      const user = await registerUser(t);
      await t.get<UsersService>(UsersService).setStatus(user.id, 'banned');
      failure(await http.get('/auth/me', user.token), 403, 'ACCOUNT_BANNED');
      failure(await http.post('/auth/refresh', { refreshToken: user.refreshToken }), 401);
    });

    it('lets a suspended account sign in and read its profile, but nothing else', async () => {
      const user = await registerUser(t);
      await t.get<UsersService>(UsersService).setStatus(user.id, 'suspended');
      const session = data(await http.post('/auth/sign-in', { email: user.email, password: PASSWORD }));
      expect(data(await http.get('/auth/me', session.tokens.accessToken)).status).toBe('suspended');
      failure(await http.post('/auth/password/verify', { password: PASSWORD }, session.tokens.accessToken), 403, 'ACCOUNT_SUSPENDED');
    });
  });

  describe('password reset', () => {
    it('does not reveal whether an account exists', async () => {
      const before = t.mail.outbox.length;
      const email = uniqueEmail('ghost');
      const result = data(await http.post('/auth/password/forgot', { identifier: email }));
      expect(result.sent).toBe(true);
      await t.mail.idle();
      expect(t.mail.outbox.slice(before).some((mail) => mail.to === email)).toBe(false);
    });

    it('resets with a mailed code, ends old sessions and rejects the old password', async () => {
      const user = await registerUser(t);
      const sent = data(await http.post('/auth/password/forgot', { identifier: user.email }));
      expect(sent.channel).toBe('email');
      const code = await codeFromMail(t, user.email);
      const verified = data(await http.post('/auth/otp/verify', { purpose: 'reset-password', identifier: user.email, code }));
      expect(verified.resetToken).toEqual(expect.any(String));

      data(await http.post('/auth/password/reset', { resetToken: verified.resetToken, password: 'NewPass#2025' }));
      failure(await http.post('/auth/sign-in', { email: user.email, password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
      data(await http.post('/auth/sign-in', { email: user.email, password: 'NewPass#2025' }));
      failure(await http.get('/auth/me', user.token), 401, 'SESSION_REVOKED');
      failure(await http.post('/auth/refresh', { refreshToken: user.refreshToken }), 401);

      // The reset token dies with the password it replaced.
      failure(await http.post('/auth/password/reset', { resetToken: verified.resetToken, password: 'Another#2025' }), 400, 'RESET_TOKEN_INVALID');
      await t.mail.idle();
      expect(t.mail.lastTo(user.email)?.subject).toBe('Your DOOAA password was changed');
    });

    it('can send the reset code to the phone number instead', async () => {
      const user = await registerUser(t);
      const sent = data(await http.post('/auth/password/forgot', { identifier: user.phone }));
      expect(sent.channel).toBe('sms');
      const code = await codeFromSms(t, user.phone);
      const verified = data(await http.post('/auth/otp/verify', { purpose: 'reset-password', identifier: user.phone, code }));
      expect(verified.resetToken).toBeDefined();
    });

    it('rejects a forged reset token', async () => {
      failure(await http.post('/auth/password/reset', { resetToken: 'x'.repeat(40), password: 'NewPass#2025' }), 400, 'RESET_TOKEN_INVALID');
    });

    it('validates the new password', async () => {
      failure(await http.post('/auth/password/reset', { resetToken: 'x'.repeat(40), password: 'weak' }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('password re-confirmation and roles', () => {
    it('re-confirms the password before sensitive actions', async () => {
      const user = await registerUser(t);
      expect(data(await http.post('/auth/password/verify', { password: PASSWORD }, user.token))).toEqual({ ok: true });
      failure(await http.post('/auth/password/verify', { password: 'Wrong@1234' }, user.token), 400, 'INVALID_PASSWORD');
    });

    it('picks a role during onboarding and can become a seller later', async () => {
      const user = await registerUser(t, { role: null });
      expect(data(await http.get('/auth/me', user.token)).role).toBeNull();
      expect(data(await http.patch('/auth/role', { role: 'buyer' }, user.token)).role).toBe('buyer');
      expect(data(await http.patch('/auth/role', { role: 'seller' }, user.token)).role).toBe('seller');
      expect(data(await http.patch('/auth/role', { role: 'buyer' }, user.token)).role).toBe('buyer');
    });

    it('rejects an unknown role', async () => {
      const user = await registerUser(t);
      const result = failure(await http.patch('/auth/role', { role: 'admin' }, user.token), 400, 'VALIDATION_FAILED');
      expect(result.error).toBe('Choose buyer or seller.');
    });
  });
});
