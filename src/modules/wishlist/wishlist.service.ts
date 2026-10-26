import { Injectable, OnModuleInit } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import { InjectDb, isUniqueViolation, type Database } from '../../database/database';
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
    const rows = await this.db.find(wishlistItems, { userId: user.id }, { sort: { createdAt: -1 }, limit });
    return rows.map((row) => row.productId);
  }

  async count(userId: string): Promise<number> {
    return this.db.count(wishlistItems, { userId });
  }

  async add(user: AuthUser, productId: string): Promise<{ wishlisted: true; count: number }> {
    await this.products.findPublic(productId);
    const inserted = await this.db.insertIgnoringDuplicates(wishlistItems, [{ userId: user.id, productId }]);
    if (inserted) await this.products.adjustWishlistCount(productId, 1);
    return { wishlisted: true, count: await this.count(user.id) };
  }

  async remove(user: AuthUser, productId: string): Promise<{ wishlisted: false; count: number }> {
    const removed = await this.db.delete(wishlistItems, { userId: user.id, productId });
    if (removed) await this.products.adjustWishlistCount(productId, -1);
    return { wishlisted: false, count: await this.count(user.id) };
  }

  async clear(user: AuthUser): Promise<{ cleared: number }> {
    const removed = await this.db.find(wishlistItems, { userId: user.id });
    await this.db.deleteMany(wishlistItems, { id: { $in: removed.map((row) => row.id) } });
    await Promise.all(removed.map((row) => this.products.adjustWishlistCount(row.productId, -1)));
    return { cleared: removed.length };
  }

  /** "Restock alerts on/off" for an item. Turning one on also saves the item. */
  async setRestockAlert(user: AuthUser, productId: string, on: boolean): Promise<{ restockAlert: boolean }> {
    const product = await this.products.findById(productId);
    if (!product) throw Errors.notFound('This item is no longer listed.', 'PRODUCT_NOT_FOUND');
    if (on) {
      const existing = await this.db.update(wishlistItems, { userId: user.id, productId: product.id }, { restockAlert: true });
      if (!existing) {
        try {
          await this.db.insert(wishlistItems, { userId: user.id, productId: product.id, restockAlert: true });
          await this.products.adjustWishlistCount(product.id, 1);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          await this.db.update(wishlistItems, { userId: user.id, productId: product.id }, { restockAlert: true });
        }
      }
    } else {
      await this.db.update(wishlistItems, { userId: user.id, productId: product.id }, { restockAlert: false });
    }
    return { restockAlert: on };
  }

  /** Tells everyone waiting on an item that it is back, once. */
  private async notifyRestock(event: ProductRestocked): Promise<void> {
    const waiting = await this.db.find(wishlistItems, { productId: event.productId, restockAlert: true });
    await this.db.updateMany(wishlistItems, { id: { $in: waiting.map((row) => row.id) }, restockAlert: true }, { restockAlert: false });
    if (!waiting.length) return;
    this.events.publish<RestockAlert>(WISHLIST_EVENTS.restockAlert, {
      userIds: waiting.map((row) => row.userId),
      productId: event.productId,
      title: event.title,
    });
  }
}
