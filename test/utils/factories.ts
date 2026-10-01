import { randomBytes } from 'node:crypto';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { TestApp } from './app';
import { Http, data } from './http';
import { User } from '../../src/modules/users/schemas/user.schema';
import { PasswordService } from '../../src/modules/users/password.service';
import { Staff, type StaffStatus } from '../../src/modules/staff/schemas/staff.schema';
import type { StaffRole } from '../../src/common/domain';

export const PASSWORD = 'Dooaa@123';

export type TestUser = {
  id: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  password: string;
  token: string;
  refreshToken: string;
};

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomBytes(4).toString('hex')}@example.com`;
}

export function uniquePhone(): string {
  return `080${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

/** The six-digit code in the most recent email to an address. */
export async function codeFromMail(t: TestApp, email: string): Promise<string> {
  await t.mail.idle();
  const mail = t.mail.lastTo(email);
  const match = mail?.text.match(/Code: (\d{6})/);
  if (!match) throw new Error(`No code mailed to ${email}`);
  return match[1];
}

export async function codeFromSms(t: TestApp, phone: string): Promise<string> {
  const sms = t.sms.lastTo(phone);
  const match = sms?.body.match(/(\d{6})/);
  if (!match) throw new Error(`No code texted to ${phone}`);
  return match[1];
}

/** Signs up, confirms the email and (optionally) picks a role. */
export async function registerUser(
  t: TestApp,
  options: { role?: 'buyer' | 'seller' | null; verifyEmail?: boolean; firstName?: string; lastName?: string; email?: string; phone?: string; location?: string } = {},
): Promise<TestUser> {
  const http = new Http(t);
  const email = options.email ?? uniqueEmail();
  const phone = options.phone ?? uniquePhone();
  const signUp = data(
    await http.post('/auth/sign-up', {
      firstName: options.firstName ?? 'Ada',
      lastName: options.lastName ?? 'Obi',
      email,
      phone,
      password: PASSWORD,
      acceptedTerms: true,
      acceptedPrivacy: true,
    }),
  );
  if (options.verifyEmail !== false) {
    const code = await codeFromMail(t, email);
    data(await http.post('/auth/otp/verify', { purpose: 'verify-email', identifier: email, code }));
  }
  const role = options.role === undefined ? 'buyer' : options.role;
  if (role) data(await http.patch('/auth/role', { role }, signUp.tokens.accessToken));
  if (options.location) data(await http.patch('/me', { location: options.location }, signUp.tokens.accessToken));
  return {
    id: signUp.user.id,
    email,
    phone,
    firstName: signUp.user.firstName,
    lastName: signUp.user.lastName,
    password: PASSWORD,
    token: signUp.tokens.accessToken,
    refreshToken: signUp.tokens.refreshToken,
  };
}

/** A seller whose identity has been approved, so listings can go live. */
export async function registerSeller(t: TestApp, options: { verifiedIdentity?: boolean; storeName?: string; level?: 'normal' | 'high-value' } = {}): Promise<TestUser> {
  const seller = await registerUser(t, { role: 'seller', firstName: 'Sola', lastName: 'Seller' });
  const users = t.get<Model<User>>(getModelToken(User.name));
  await users.updateOne(
    { _id: seller.id },
    {
      $set: {
        identity: options.verifiedIdentity === false ? 'unverified' : 'verified',
        verificationLevel: options.level ?? 'normal',
        'seller.storeName': options.storeName ?? 'Sola Stores',
      },
    },
  );
  return seller;
}

export async function createStaff(t: TestApp, role: StaffRole = 'superadmin', overrides: Partial<{ email: string; firstName: string; lastName: string; status: StaffStatus }> = {}) {
  const staff = t.get<Model<Staff>>(getModelToken(Staff.name));
  const passwords = t.get<PasswordService>(PasswordService);
  const email = overrides.email ?? uniqueEmail(role);
  const created = await staff.create({
    firstName: overrides.firstName ?? 'Nelson',
    lastName: overrides.lastName ?? 'Doe',
    email,
    role,
    title: role[0].toUpperCase() + role.slice(1),
    status: overrides.status ?? 'active',
    passwordHash: await passwords.hash(PASSWORD),
  });
  return { id: String(created._id), email, password: PASSWORD, role };
}

export async function staffToken(t: TestApp, role: StaffRole = 'superadmin', overrides: Parameters<typeof createStaff>[2] = {}) {
  const member = await createStaff(t, role, overrides);
  const http = new Http(t);
  const session = data(await http.post('/admin/auth/sign-in', { email: member.email, password: member.password }));
  return { ...member, token: session.tokens.accessToken as string, refreshToken: session.tokens.refreshToken as string };
}

export function model<T>(t: TestApp, name: string): Model<T> {
  return t.get<Model<T>>(getModelToken(name));
}

/* --- Catalog ---------------------------------------------------------------- */

import request from 'supertest';
import { Types } from 'mongoose';
import { Product } from '../../src/modules/products/schemas/product.schema';
import { FILES } from './files';
import { API } from './http';
import { SettingsService } from '../../src/modules/settings/settings.service';

let productCounter = 0;

/** Inserts a listing directly (fast path for catalog tests). */
export async function createProduct(t: TestApp, sellerId: string, overrides: Record<string, unknown> = {}) {
  productCounter += 1;
  const products = model<Product>(t, Product.name);
  const title = (overrides.title as string | undefined) ?? `Apple iPhone 12 Pro 512 GB Blue #${productCounter}`;
  const created = await products.create({
    sellerId: new Types.ObjectId(sellerId),
    title,
    description: `${title} — clean, tested and ready to go.`,
    summary: `${title} in great condition`,
    highlights: ['512GB storage', 'Battery health 89%'],
    categoryId: 'gatdgets',
    brand: 'Apple',
    condition: 'used',
    price: 400_000,
    pricing: 'fixed',
    paymentMethod: 'escrow',
    delivery: 'nationwide',
    stock: 5,
    location: 'Ikeja, Lagos',
    images: ['https://res.cloudinary.com/demo/image/upload/iphone.jpg'],
    status: 'active',
    sellerVerified: true,
    publishedAt: new Date(Date.now() - productCounter * 1000),
    ...overrides,
  });
  return created.toObject() as unknown as { _id: Types.ObjectId; title: string; price: number; categoryId: string; stock: number };
}

/** Uploads a real (tiny) image through the media endpoint and returns its URL. */
export async function uploadImage(t: TestApp, token: string, purpose = 'product', staff = false): Promise<string> {
  const response = await request(t.server)
    .post(`${API}/${staff ? 'admin/media' : 'media'}`)
    .set('Authorization', `Bearer ${token}`)
    .field('purpose', purpose)
    .attach('file', FILES.jpeg(), 'photo.jpg');
  if (response.status !== 201) throw new Error(`upload failed: ${JSON.stringify(response.body)}`);
  return response.body.data.url as string;
}

/** Updates a settings section directly through the service (no staff token needed). */
export async function setSettings(t: TestApp, section: string, patch: Record<string, unknown>) {
  const settings = t.get<SettingsService>(SettingsService);
  const current = (await settings.get()) as unknown as Record<string, Record<string, unknown>>;
  await settings.update(section as never, { ...current[section], ...patch }, {
    kind: 'staff',
    id: new Types.ObjectId().toHexString(),
    email: 'system@dooaa.ng',
    firstName: 'Test',
    lastName: 'Harness',
    role: 'superadmin',
    status: 'active',
    tokenVersion: 0,
  });
}
