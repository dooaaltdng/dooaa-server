import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { regionFor } from '../common/domain';
import { excerpt, normalizePhone } from '../common/util/text';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { loadEnvFiles } from '../config/env-files';
import { DATABASE, type Database } from '../database/database';
import { products, users } from '../database/schema';
import { ProductsService } from '../modules/products/products.service';
import { StaffService } from '../modules/staff/staff.service';
import { PasswordService } from '../modules/users/password.service';
import { DEMO_BUYER, DEMO_LISTINGS, DEMO_PASSWORD, DEMO_SELLER } from './demo-data';

/**
 * Seeds a database whose schema is current (`npm run db:migrate` first).
 * Safe to run repeatedly: nothing that exists is changed.
 *
 *   npm run seed                      # superadmin + reference data
 *   SEED_DEMO=true npm run seed       # …plus demo buyer, seller and listings
 *
 * Categories, the DOOAA10 coupon and the six content pages are created by
 * the app itself on boot; the superadmin comes from SEED_SUPERADMIN_*.
 */
async function main(): Promise<void> {
  loadEnvFiles();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const config = app.get<AppConfig>(APP_CONFIG);
    const log = (message: string) => console.log(`[seed] ${message}`);

    const password = config.seed.superadminPassword ?? (config.env === 'production' ? undefined : DEMO_PASSWORD);
    if (!password) throw new Error('Set SEED_SUPERADMIN_PASSWORD to create the first console account.');
    const superadmin = await app.get(StaffService).ensureSuperadmin({
      email: config.seed.superadminEmail,
      firstName: config.seed.superadminFirstName,
      lastName: config.seed.superadminLastName,
      password,
    });
    log(`Superadmin: ${superadmin.email}`);

    await app.get(ProductsService).officialStore();
    log('Official store account ready (store@dooaa.ng).');

    if (process.env.SEED_DEMO === 'true') {
      if (config.env === 'production' && process.env.SEED_DEMO_IN_PRODUCTION !== 'true') {
        throw new Error('Refusing to seed demo data in production (set SEED_DEMO_IN_PRODUCTION=true to override).');
      }
      const db = app.get<Database>(DATABASE);
      const hash = await app.get(PasswordService).hash(DEMO_PASSWORD);

      const ensureUser = async (person: typeof DEMO_BUYER & { storeName?: string }, role: 'buyer' | 'seller') => {
        const now = new Date();
        await db
          .insert(users)
          .values({
            firstName: person.firstName,
            lastName: person.lastName,
            email: person.email,
            phone: normalizePhone(person.phone),
            passwordHash: hash,
            role,
            emailVerified: true,
            identity: 'verified',
            verificationLevel: role === 'seller' ? 'high-value' : 'normal',
            location: person.location,
            region: regionFor(person.location) ?? null,
            termsAcceptedAt: now,
            privacyAcceptedAt: now,
            ...(person.storeName
              ? {
                  sellerStoreName: person.storeName,
                  sellerDispatchDays: 3,
                  sellerResponseLabel: 'Typically responds within an hour',
                  sellerDeliveryLabel: 'Nationwide Delivery (1-3 business days within Lagos)',
                }
              : {}),
          })
          .onConflictDoNothing({ target: users.email });
        const [row] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, person.email));
        return row;
      };

      const buyer = await ensureUser(DEMO_BUYER, 'buyer');
      const seller = await ensureUser(DEMO_SELLER, 'seller');
      log(`Demo buyer: ${buyer.email} / ${DEMO_PASSWORD}`);
      log(`Demo seller: ${seller.email} / ${DEMO_PASSWORD}`);

      let created = 0;
      for (const [index, listing] of DEMO_LISTINGS.entries()) {
        const [existing] = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.sellerId, seller.id), eq(products.title, listing.title)));
        if (existing) continue;
        await db.insert(products).values({
          sellerId: seller.id,
          title: listing.title,
          description: listing.description,
          summary: excerpt(listing.description, 120),
          highlights: listing.highlights,
          categoryId: listing.categoryId,
          brand: listing.brand,
          condition: listing.condition,
          price: listing.price,
          pricing: listing.pricing,
          paymentMethod: 'escrow',
          delivery: listing.delivery,
          stock: listing.stock,
          location: listing.location,
          images: [`${config.clientUrl}${listing.image}`],
          status: 'active',
          featured: Boolean(listing.featured),
          sellerVerified: true,
          listedAs: 'seller',
          publishedAt: new Date(Date.now() - index * 3_600_000),
        });
        created += 1;
      }
      await app.get(ProductsService).recountActiveListings(seller.id);
      log(`Demo listings: ${created} created (${DEMO_LISTINGS.length - created} already present).`);
    }
    log('Done.');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`[seed] ${(error as Error).message}`);
  process.exit(1);
});
