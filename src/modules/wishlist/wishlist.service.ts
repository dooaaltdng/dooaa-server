import { Injectable, OnModuleInit } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import { InjectDb, type Database } from '../../database/database';
import { wishlistItems } from '../../database/schema';
import type { ProductCard } from '../products/product.presenter';
import { PRODUCT_EVENTS, ProductsService, type ProductRestocked } from '../products/products.service';

export const WISHLIST_EVENTS = { restockAlert: 'wishlist.restock-alert' } as const;
export type RestockAlert = { userIds: string[]; productId: string; title: string };

@Injectable()
export class WishlistService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly products: ProductsService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<ProductRestocked>(PRODUCT_EVENTS.restocked, (event) => this.notifyRestock(event));
  }

  async list(user: AuthUser): Promise<ProductCard[]> {
    return this.products.cardsByIds(await this.ids(user, 500), user, true);
  }

  async ids(user: AuthUser, limit?: number): Promise<string[]> {
    const query = this.db
      .select({ productId: wishlistItems.productId })
      .from(wishlistItems)
      .where(eq(wishlistItems.userId, user.id))
      .orderBy(desc(wishlistItems.createdAt))
      .$dynamic();
    const rows = await (limit ? query.limit(limit) : query);
    return rows.map((row) => row.productId);
  }

  async count(userId: string): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(wishlistItems).where(eq(wishlistItems.userId, userId));
    return row.total;
  }

  async add(user: AuthUser, productId: string): Promise<{ wishlisted: true; count: number }> {
    await this.products.findPublic(productId);
    const inserted = await this.db
      .insert(wishlistItems)
      .values({ userId: user.id, productId })
      .onConflictDoNothing({ target: [wishlistItems.userId, wishlistItems.productId] })
      .returning({ id: wishlistItems.id });
    if (inserted.length) await this.products.adjustWishlistCount(productId, 1);
    return { wishlisted: true, count: await this.count(user.id) };
  }

  async remove(user: AuthUser, productId: string): Promise<{ wishlisted: false; count: number }> {
    const removed = await this.db
      .delete(wishlistItems)
      .where(and(eq(wishlistItems.userId, user.id), eq(wishlistItems.productId, productId)))
      .returning({ id: wishlistItems.id });
    if (removed.length) await this.products.adjustWishlistCount(productId, -1);
    return { wishlisted: false, count: await this.count(user.id) };
  }

  async clear(user: AuthUser): Promise<{ cleared: number }> {
    const removed = await this.db.delete(wishlistItems).where(eq(wishlistItems.userId, user.id)).returning({ productId: wishlistItems.productId });
    await Promise.all(removed.map((row) => this.products.adjustWishlistCount(row.productId, -1)));
    return { cleared: removed.length };
  }

  /** "Restock alerts on/off" for an item. Turning one on also saves the item. */
  async setRestockAlert(user: AuthUser, productId: string, on: boolean): Promise<{ restockAlert: boolean }> {
    const product = await this.products.findById(productId);
    if (!product) throw Errors.notFound('This item is no longer listed.', 'PRODUCT_NOT_FOUND');
    if (on) {
      // `xmax = 0` is true only for a freshly inserted row: the item was not saved before.
      const [row] = await this.db
        .insert(wishlistItems)
        .values({ userId: user.id, productId: product.id, restockAlert: true })
        .onConflictDoUpdate({ target: [wishlistItems.userId, wishlistItems.productId], set: { restockAlert: true } })
        .returning({ inserted: sql<boolean>`xmax = 0` });
      if (row?.inserted) await this.products.adjustWishlistCount(product.id, 1);
    } else {
      await this.db
        .update(wishlistItems)
        .set({ restockAlert: false })
        .where(and(eq(wishlistItems.userId, user.id), eq(wishlistItems.productId, product.id)));
    }
    return { restockAlert: on };
  }

  /** Tells everyone waiting on an item that it is back, once. */
  private async notifyRestock(event: ProductRestocked): Promise<void> {
    const waiting = await this.db
      .update(wishlistItems)
      .set({ restockAlert: false })
      .where(and(eq(wishlistItems.productId, event.productId), eq(wishlistItems.restockAlert, true)))
      .returning({ userId: wishlistItems.userId });
    if (!waiting.length) return;
    this.events.publish<RestockAlert>(WISHLIST_EVENTS.restockAlert, {
      userIds: waiting.map((row) => row.userId),
      productId: event.productId,
      title: event.title,
    });
  }
}
