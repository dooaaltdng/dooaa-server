import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { regionFor } from '../common/domain';
import { excerpt, normalizePhone } from '../common/util/text';
import { Product } from '../modules/products/schemas/product.schema';
import { ProductsService } from '../modules/products/products.service';
import { StaffService } from '../modules/staff/staff.service';
import { PasswordService } from '../modules/users/password.service';
import { User } from '../modules/users/schemas/user.schema';
import { DEMO_BUYER, DEMO_LISTINGS, DEMO_PASSWORD, DEMO_SELLER } from './demo-data';

/**
 * Seeds a database. Safe to run repeatedly: nothing that exists is changed.
 *
 *   npm run seed                      # superadmin + reference data
 *   SEED_DEMO=true npm run seed       # …plus demo buyer, seller and listings
 *
 * Categories, the DOOAA10 coupon and the six content pages are created by
 * the app itself on boot; the superadmin comes from SEED_SUPERADMIN_*.
 */
async function main(): Promise<void> {
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
      const users = app.get<Model<User>>(getModelToken(User.name));
      const products = app.get<Model<Product>>(getModelToken(Product.name));
      const hash = await app.get(PasswordService).hash(DEMO_PASSWORD);

      const upsertUser = async (person: typeof DEMO_BUYER & { storeName?: string }, role: 'buyer' | 'seller') => {
        await users.updateOne(
          { email: person.email },
          {
            $setOnInsert: {
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
              region: regionFor(person.location),
              termsAcceptedAt: new Date(),
              privacyAcceptedAt: new Date(),
              ...(person.storeName ? { seller: { storeName: person.storeName, dispatchDays: 3, responseLabel: 'Typically responds within an hour', deliveryLabel: 'Nationwide Delivery (1-3 business days within Lagos)' } } : {}),
            },
          },
          { upsert: true },
        );
        return (await users.findOne({ email: person.email }).lean())!;
      };

      const buyer = await upsertUser(DEMO_BUYER, 'buyer');
      const seller = await upsertUser(DEMO_SELLER, 'seller');
      log(`Demo buyer: ${buyer.email} / ${DEMO_PASSWORD}`);
      log(`Demo seller: ${seller.email} / ${DEMO_PASSWORD}`);

      const imageBase = `${config.clientUrl}`;
      let created = 0;
      for (const [index, listing] of DEMO_LISTINGS.entries()) {
        const exists = await products.exists({ sellerId: seller._id, title: listing.title });
        if (exists) continue;
        await products.create({
          sellerId: seller._id,
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
          images: [`${imageBase}${listing.image}`],
          status: 'active',
          featured: Boolean(listing.featured),
          sellerVerified: true,
          listedAs: 'seller',
          publishedAt: new Date(Date.now() - index * 3_600_000),
        });
        created += 1;
      }
      await app.get(ProductsService).recountActiveListings(seller._id);
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
