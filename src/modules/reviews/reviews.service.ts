import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { REVIEW_ASPECTS, REVIEW_ASPECT_LABEL, type ReviewAspect } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Order } from '../orders/schemas/order.schema';
import { Product } from '../products/schemas/product.schema';
import { User } from '../users/schemas/user.schema';
import { Review } from './review.schema';

export type ReviewView = {
  id: string;
  orderNumber: string | null;
  name: string;
  /** Kept for the product page's "author" field. */
  author: string;
  avatar: string | null;
  /** Every review is from a buyer who paid through DOOAA. */
  verified: true;
  rating: number;
  aspects: Partial<Record<ReviewAspect, number>>;
  at: string;
  body: string;
  response: { body: string; at: string } | null;
};

export type RatingSummary = {
  average: number;
  total: number;
  distribution: { stars: number; count: number }[];
  aspects: { key: ReviewAspect; label: string; score: number }[];
};

/** A review chosen for the landing page's "Trusted by sellers loved by buyers" rail. */
export type ReviewHighlight = {
  id: string;
  rating: number;
  /** What was bought, as the card's heading. */
  title: string;
  body: string;
  /** First name and last initial only. */
  author: string;
  location: string | null;
  avatar: string | null;
  at: string;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review.name) private readonly reviews: Model<Review>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private async views(rows: Lean<Review>[]): Promise<ReviewView[]> {
    const [buyers, orders] = await Promise.all([
      this.users.find({ _id: { $in: rows.map((row) => row.buyerId) } }).select('firstName lastName avatarUrl').lean(),
      this.orders.find({ _id: { $in: rows.map((row) => row.orderId) } }).select('reference').lean(),
    ]);
    const buyerById = new Map(buyers.map((buyer) => [String(buyer._id), buyer]));
    const orderById = new Map(orders.map((order) => [String(order._id), order]));
    return rows.map((row) => {
      const buyer = buyerById.get(String(row.buyerId));
      const name = buyer ? `${buyer.firstName} ${buyer.lastName}`.trim() : 'DOOAA buyer';
      const order = orderById.get(String(row.orderId));
      return {
        id: String(row._id),
        orderNumber: order ? `#${order.reference}` : null,
        name,
        author: name,
        avatar: buyer?.avatarUrl ?? null,
        verified: true,
        rating: row.rating,
        aspects: Object.fromEntries(REVIEW_ASPECTS.filter((key) => row.aspects?.[key]).map((key) => [key, row.aspects[key]!])),
        at: new Date(row.createdAt).toISOString(),
        body: row.body,
        response: row.response ? { body: row.response.body, at: new Date(row.response.at).toISOString() } : null,
      };
    });
  }

  /** "Write a review" on a completed order (escrow released). One per order. */
  async create(user: AuthUser, orderIdOrReference: string, input: { rating: number; aspects?: Partial<Record<ReviewAspect, number>>; body?: string }): Promise<ReviewView> {
    const reference = orderIdOrReference.replace(/^#/, '');
    const filter = /^[a-f\d]{24}$/i.test(reference) ? { _id: new Types.ObjectId(reference) } : { reference };
    const order = await this.orders.findOne({ ...filter, buyerId: new Types.ObjectId(user.id) }).lean<Lean<Order>>();
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    if (order.escrow?.phase !== 'released') throw Errors.conflict('You can review an order once it is complete.', 'ORDER_NOT_COMPLETE');
    if (order.reviewId) throw Errors.conflict('You have already reviewed this order.', 'ALREADY_REVIEWED');
    let created;
    try {
      created = await this.reviews.create({
        orderId: order._id,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        productIds: order.items.map((item) => item.productId),
        rating: input.rating,
        aspects: input.aspects ?? {},
        body: input.body?.trim() ?? '',
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw Errors.conflict('You have already reviewed this order.', 'ALREADY_REVIEWED');
      throw error;
    }
    await this.orders.updateOne({ _id: order._id }, { $set: { reviewId: created._id } });
    await this.recompute(order.sellerId, order.items.map((item) => item.productId));
    void this.notifications.notifyUser(order.sellerId, {
      type: 'review.new',
      title: `New ${input.rating}-star review`,
      body: input.body ? input.body.slice(0, 140) : `A buyer rated order #${order.reference}.`,
      tone: input.rating >= 4 ? 'green' : 'blue',
      category: 'feedback',
      link: '/seller/ratings',
    });
    return (await this.views([created.toObject() as Lean<Review>]))[0];
  }

  /** Recomputes the seller's and the products' averages from the visible reviews. */
  async recompute(sellerId: Types.ObjectId, productIds: Types.ObjectId[]): Promise<void> {
    const [seller] = await this.reviews.aggregate<{ average: number; count: number }>([
      { $match: { sellerId, hidden: false } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    await this.users.updateOne({ _id: sellerId }, { $set: { 'stats.ratingAverage': round1(seller?.average ?? 0), 'stats.ratingCount': seller?.count ?? 0 } });
    for (const productId of productIds) {
      const [product] = await this.reviews.aggregate<{ average: number; count: number }>([
        { $match: { productIds: productId, hidden: false } },
        { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]);
      await this.products.updateOne({ _id: productId }, { $set: { 'stats.ratingAverage': round1(product?.average ?? 0), 'stats.ratingCount': product?.count ?? 0 } });
    }
  }

  /** The Ratings page's summary cards: average, distribution and per-aspect scores. */
  async summary(sellerId: string): Promise<RatingSummary> {
    const match = { sellerId: new Types.ObjectId(sellerId), hidden: false };
    const [totals] = await this.reviews.aggregate<Record<string, number>>([
      { $match: match },
      {
        $group: {
          _id: null,
          average: { $avg: '$rating' },
          total: { $sum: 1 },
          ...Object.fromEntries(REVIEW_ASPECTS.map((key) => [key, { $avg: `$aspects.${key}` }])),
        },
      },
    ]);
    const distribution = await this.reviews.aggregate<{ _id: number; count: number }>([{ $match: match }, { $group: { _id: '$rating', count: { $sum: 1 } } }]);
    const byStars = new Map(distribution.map((row) => [row._id, row.count]));
    return {
      average: round1(totals?.average ?? 0),
      total: totals?.total ?? 0,
      distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: byStars.get(stars) ?? 0 })),
      aspects: REVIEW_ASPECTS.map((key) => ({ key, label: REVIEW_ASPECT_LABEL[key], score: round1(totals?.[key] ?? 0) })),
    };
  }

  async forSeller(sellerId: string, page = 1, limit = 10): Promise<Page<ReviewView>> {
    const filter = { sellerId: new Types.ObjectId(sellerId), hidden: false };
    const total = await this.reviews.countDocuments(filter);
    const window = pageWindow(total, page, limit);
    const rows = await this.reviews.find(filter).sort({ createdAt: -1 }).skip(window.skip).limit(window.size).lean<Lean<Review>[]>();
    return toPage(await this.views(rows), total, window);
  }

  async forProduct(productId: string, page = 1, limit = 10): Promise<Page<ReviewView>> {
    const filter = { productIds: new Types.ObjectId(productId), hidden: false };
    const total = await this.reviews.countDocuments(filter);
    const window = pageWindow(total, page, limit);
    const rows = await this.reviews.find(filter).sort({ createdAt: -1 }).skip(window.skip).limit(window.size).lean<Lean<Review>[]>();
    return toPage(await this.views(rows), total, window);
  }

  /**
   * Recent 4–5 star reviews with something to say, at most one per buyer,
   * for the landing page. Only real reviews from paid orders appear.
   */
  async highlights(limit = 3): Promise<ReviewHighlight[]> {
    const rows = await this.reviews
      .aggregate<Lean<Review>>([
        { $match: { hidden: false, rating: { $gte: 4 }, $expr: { $gte: [{ $strLenCP: '$body' }, 40] } } },
        { $sort: { rating: -1, createdAt: -1 } },
        { $limit: 200 },
        { $group: { _id: '$buyerId', review: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$review' } },
        { $sort: { rating: -1, createdAt: -1 } },
        { $limit: limit },
      ])
      .exec();
    const [buyers, products] = await Promise.all([
      this.users.find({ _id: { $in: rows.map((row) => row.buyerId) }, status: { $ne: 'closed' } }).select('firstName lastName avatarUrl location region').lean(),
      this.products.find({ _id: { $in: rows.map((row) => row.productIds[0]).filter(Boolean) } }).select('title').lean(),
    ]);
    const buyerById = new Map(buyers.map((buyer) => [String(buyer._id), buyer]));
    const titleById = new Map(products.map((product) => [String(product._id), (product as { title?: string }).title ?? '']));
    return rows.flatMap((row) => {
      const buyer = buyerById.get(String(row.buyerId));
      if (!buyer) return [];
      const place = [buyer.location, buyer.region].filter(Boolean);
      return [
        {
          id: String(row._id),
          rating: row.rating,
          title: titleById.get(String(row.productIds[0])) || 'Verified purchase',
          body: row.body,
          author: `${buyer.firstName} ${buyer.lastName ? `${buyer.lastName[0]}.` : ''}`.trim(),
          location: place.length ? Array.from(new Set(place)).join(', ') : null,
          avatar: buyer.avatarUrl ?? null,
          at: new Date(row.createdAt).toISOString(),
        },
      ];
    });
  }

  /** The seller's public reply under a review. */
  async reply(user: AuthUser, reviewId: string, body: string): Promise<ReviewView> {
    if (!Types.ObjectId.isValid(reviewId)) throw Errors.notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
    const updated = await this.reviews
      .findOneAndUpdate({ _id: reviewId, sellerId: new Types.ObjectId(user.id), hidden: false }, { $set: { response: { body, at: new Date() } } }, { returnDocument: 'after' })
      .lean<Lean<Review>>();
    if (!updated) throw Errors.notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
    void this.notifications.notifyUser(updated.buyerId, {
      type: 'review.reply',
      title: 'The seller replied to your review',
      body: body.slice(0, 140),
      category: 'feedback',
    });
    return (await this.views([updated]))[0];
  }

  async setHidden(staff: AuthStaff, reviewId: string, hidden: boolean): Promise<ReviewView> {
    if (!Types.ObjectId.isValid(reviewId)) throw Errors.notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
    const updated = await this.reviews.findByIdAndUpdate(reviewId, { $set: { hidden } }, { returnDocument: 'after' }).lean<Lean<Review>>();
    if (!updated) throw Errors.notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
    await this.recompute(updated.sellerId, updated.productIds);
    await this.audit.record(staff, { action: hidden ? 'Hid a review' : 'Restored a review', target: updated.body.slice(0, 60) || `${updated.rating}-star review`, targetType: 'review', targetId: reviewId });
    return (await this.views([updated]))[0];
  }
}
