import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthUser } from '../../common/auth/principal';
import { EventBus } from '../../common/events/event-bus';
import { PRODUCT_EVENTS, ProductsService, type ProductRestocked } from '../products/products.service';
import type { ProductCard } from '../products/product.presenter';
import { WishlistItem } from './wishlist.schema';

export const WISHLIST_EVENTS = { restockAlert: 'wishlist.restock-alert' } as const;
export type RestockAlert = { userIds: string[]; productId: string; title: string };

@Injectable()
export class WishlistService implements OnModuleInit {
  constructor(
    @InjectModel(WishlistItem.name) private readonly items: Model<WishlistItem>,
    private readonly products: ProductsService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<ProductRestocked>(PRODUCT_EVENTS.restocked, (event) => this.notifyRestock(event));
  }

  async list(user: AuthUser): Promise<ProductCard[]> {
    const rows = await this.items.find({ userId: new Types.ObjectId(user.id) }).sort({ createdAt: -1 }).limit(500).lean();
    return this.products.cardsByIds(rows.map((row) => row.productId), user, true);
  }

  async ids(user: AuthUser): Promise<string[]> {
    const rows = await this.items.find({ userId: new Types.ObjectId(user.id) }).sort({ createdAt: -1 }).select('productId').lean();
    return rows.map((row) => String(row.productId));
  }

  async count(userId: string): Promise<number> {
    return this.items.countDocuments({ userId: new Types.ObjectId(userId) });
  }

  async add(user: AuthUser, productId: string): Promise<{ wishlisted: true; count: number }> {
    await this.products.findPublic(productId);
    const result = await this.items.updateOne(
      { userId: new Types.ObjectId(user.id), productId: new Types.ObjectId(productId) },
      { $setOnInsert: { restockAlert: false } },
      { upsert: true },
    );
    if (result.upsertedCount) await this.products.adjustWishlistCount(productId, 1);
    return { wishlisted: true, count: await this.count(user.id) };
  }

  async remove(user: AuthUser, productId: string): Promise<{ wishlisted: false; count: number }> {
    const removed = await this.items.deleteOne({ userId: new Types.ObjectId(user.id), productId: new Types.ObjectId(productId) });
    if (removed.deletedCount) await this.products.adjustWishlistCount(productId, -1);
    return { wishlisted: false, count: await this.count(user.id) };
  }

  async clear(user: AuthUser): Promise<{ cleared: number }> {
    const rows = await this.items.find({ userId: new Types.ObjectId(user.id) }).select('productId').lean();
    await this.items.deleteMany({ userId: new Types.ObjectId(user.id) });
    await Promise.all(rows.map((row) => this.products.adjustWishlistCount(row.productId, -1)));
    return { cleared: rows.length };
  }

  /** "Restock alerts on/off" for an item. Turning one on also saves the item. */
  async setRestockAlert(user: AuthUser, productId: string, on: boolean): Promise<{ restockAlert: boolean }> {
    const product = await this.products.findById(productId);
    if (!product) throw Errors.notFound('This item is no longer listed.', 'PRODUCT_NOT_FOUND');
    const result = await this.items.updateOne(
      { userId: new Types.ObjectId(user.id), productId: product._id },
      { $set: { restockAlert: on } },
      { upsert: on },
    );
    if (result.upsertedCount) await this.products.adjustWishlistCount(productId, 1);
    return { restockAlert: on };
  }

  /** Tells everyone waiting on an item that it is back, once. */
  private async notifyRestock(event: ProductRestocked): Promise<void> {
    const waiting = await this.items.find({ productId: new Types.ObjectId(event.productId), restockAlert: true }).select('userId').lean();
    if (!waiting.length) return;
    await this.items.updateMany({ productId: new Types.ObjectId(event.productId), restockAlert: true }, { $set: { restockAlert: false } });
    this.events.publish<RestockAlert>(WISHLIST_EVENTS.restockAlert, {
      userIds: waiting.map((row) => String(row.userId)),
      productId: event.productId,
      title: event.title,
    });
  }
}
