import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { REVIEW_ASPECTS, REVIEW_ASPECT_LABEL, type ReviewAspect } from '../../common/domain';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, isUniqueViolation, type Database, type Where } from '../../database/database';
import { orderItems, orders, products, reviews, users } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

export type Review = typeof reviews.$inferSelect;

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
    @InjectDb() private readonly db: Database,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  private async views(rows: Review[]): Promise<ReviewView[]> {
    if (!rows.length) return [];
    const [buyers, orderRows] = await Promise.all([
      this.db.find(users, { id: { $in: rows.map((row) => row.buyerId) } }),
      this.db.find(orders, { id: { $in: rows.map((row) => row.orderId) } }),
    ]);
    const buyerById = new Map(buyers.map((buyer) => [buyer.id, buyer]));
    const orderById = new Map(orderRows.map((order) => [order.id, order]));
    return rows.map((row) => {
      const buyer = buyerById.get(row.buyerId);
      const name = buyer ? `${buyer.firstName} ${buyer.lastName}`.trim() : 'DOOAA buyer';
      const order = orderById.get(row.orderId);
      return {
        id: row.id,
        orderNumber: order ? `#${order.reference}` : null,
        name,
        author: name,
        avatar: buyer?.avatarUrl ?? null,
        verified: true,
        rating: row.rating,
        aspects: Object.fromEntries(REVIEW_ASPECTS.filter((key) => row.aspects[key]).map((key) => [key, row.aspects[key]!])),
        at: row.createdAt.toISOString(),
        body: row.body,
        response: row.response ? { body: row.response.body, at: new Date(row.response.at).toISOString() } : null,
      };
    });
  }

  /** The products a review covers: its order's items. */
  private async productIdsOf(orderId: string): Promise<string[]> {
    const rows = await this.db.find(orderItems, { orderId }, { sort: { position: 1 } });
    return rows.map((row) => row.productId);
  }

  /** "Write a review" on a completed order (escrow released). One per order. */
  async create(user: AuthUser, orderIdOrReference: string, input: { rating: number; aspects?: Partial<Record<ReviewAspect, number>>; body?: string }): Promise<ReviewView> {
    const reference = orderIdOrReference.replace(/^#/, '');
    const order = await this.db.findOne(orders, { ...(isUuid(reference) ? { id: reference } : { reference }), buyerId: user.id });
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    if (order.escrowPhase !== 'released') throw Errors.conflict('You can review an order once it is complete.', 'ORDER_NOT_COMPLETE');
    if (order.reviewId) throw Errors.conflict('You have already reviewed this order.', 'ALREADY_REVIEWED');
    let created: Review;
    try {
      created = await this.db.transaction(async (tx) => {
        const review = await tx.insert(reviews, {
          orderId: order.id,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          rating: input.rating,
          aspects: input.aspects ?? {},
          body: input.body?.trim() ?? '',
        });
        await tx.update(orders, { id: order.id }, { reviewId: review.id });
        return review;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'reviews_order_key')) throw Errors.conflict('You have already reviewed this order.', 'ALREADY_REVIEWED');
      throw error;
    }
    await this.recompute(order.sellerId, await this.productIdsOf(order.id));
    void this.notifications.notifyUser(order.sellerId, {
      type: 'review.new',
      title: `New ${input.rating}-star review`,
      body: input.body ? input.body.slice(0, 140) : `A buyer rated order #${order.reference}.`,
      tone: input.rating >= 4 ? 'green' : 'blue',
      category: 'feedback',
      link: '/seller/ratings',
    });
    return (await this.views([created]))[0];
  }

  /** Recomputes the seller's and the products' averages from the visible reviews. */
  async recompute(sellerId: string, productIds: string[]): Promise<void> {
    const seller = await this.ratingOf({ sellerId, hidden: false });
    await this.db.update(users, { id: sellerId }, { statsRatingAverage: round1(seller.average), statsRatingCount: seller.total });
    for (const productId of productIds) {
      const product = await this.ratingOf({ ...(await this.aboutProduct(productId)), hidden: false });
      await this.db.update(products, { id: productId }, { statsRatingAverage: round1(product.average), statsRatingCount: product.total });
    }
  }

  /** Reviews of orders that included the product (a review covers its order's items). */
  private async aboutProduct(productId: string): Promise<Where<Review>> {
    return { orderId: { $in: await this.db.distinct(orderItems, 'orderId', { productId }) } };
  }

  private async ratingOf(where: Where<Review>): Promise<{ average: number; total: number }> {
    const [row] = await this.db.aggregate<{ average: number | null; total: number }>(reviews, [
      { $match: where },
      { $group: { _id: null, average: { $avg: '$rating' }, total: { $sum: 1 } } },
    ]);
    return { average: row?.average ?? 0, total: row?.total ?? 0 };
  }

  /** The Ratings page's summary cards: average, distribution and per-aspect scores. */
  async summary(sellerId: string): Promise<RatingSummary> {
    const visible = { sellerId, hidden: false };
    const aspectAverages = Object.fromEntries(REVIEW_ASPECTS.map((key) => [key, { $avg: `$aspects.${key}` }]));
    const [[totals], distribution] = await Promise.all([
      this.db.aggregate<Record<string, number | null> & { average: number | null; total: number }>(reviews, [
        { $match: visible },
        { $group: { _id: null, average: { $avg: '$rating' }, total: { $sum: 1 }, ...aspectAverages } },
      ]),
      this.db.aggregate<{ stars: number; count: number }>(reviews, [
        { $match: visible },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $project: { _id: 0, stars: '$_id', count: 1 } },
      ]),
    ]);
    const byStars = new Map(distribution.map((row) => [row.stars, row.count]));
    const aspectScore = (key: ReviewAspect) => Number((totals as Record<string, unknown> | undefined)?.[key] ?? 0) || 0;
    return {
      average: round1(totals?.average ?? 0),
      total: totals?.total ?? 0,
      distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: byStars.get(stars) ?? 0 })),
      aspects: REVIEW_ASPECTS.map((key) => ({ key, label: REVIEW_ASPECT_LABEL[key], score: round1(aspectScore(key)) })),
    };
  }

  private async pageOf(where: Where<Review>, page: number, limit: number): Promise<Page<ReviewView>> {
    const total = await this.db.count(reviews, where);
    const window = pageWindow(total, page, limit);
    const rows = await this.db.find(reviews, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size });
    return toPage(await this.views(rows), total, window);
  }

  async forSeller(sellerId: string, page = 1, limit = 10): Promise<Page<ReviewView>> {
    if (!isUuid(sellerId)) return toPage([], 0, pageWindow(0, 1, limit));
    return this.pageOf({ sellerId, hidden: false }, page, limit);
  }

  async forProduct(productId: string, page = 1, limit = 10): Promise<Page<ReviewView>> {
    if (!isUuid(productId)) return toPage([], 0, pageWindow(0, 1, limit));
    return this.pageOf({ ...(await this.aboutProduct(productId)), hidden: false }, page, limit);
  }

  /**
   * Recent 4–5 star reviews with something to say, at most one per buyer,
   * for the landing page. Only real reviews from paid orders appear.
   */
  async highlights(limit = 3): Promise<ReviewHighlight[]> {
    const latest = await this.db.aggregate<Review>(reviews, [
      { $match: { hidden: false, rating: { $gte: 4 }, $expr: { $gte: [{ $strLenCP: '$body' }, 40] } } },
      { $sort: { buyerId: 1, rating: -1, createdAt: -1 } },
      { $group: { _id: '$buyerId', review: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$review' } },
      { $sort: { rating: -1, createdAt: -1 } },
      { $limit: limit * 4 },
      { $set: { id: '$_id' } },
    ]);
    const [buyers, items] = await Promise.all([
      this.db.find(users, { id: { $in: latest.map((row) => row.buyerId) }, status: { $ne: 'closed' } }),
      this.db.find(orderItems, { orderId: { $in: latest.map((row) => row.orderId) } }, { sort: { position: 1 } }),
    ]);
    const buyerById = new Map(buyers.map((buyer) => [buyer.id, buyer]));
    const titleByOrder = new Map<string, string>();
    for (const item of items) if (!titleByOrder.has(item.orderId)) titleByOrder.set(item.orderId, item.title);
    const rows = latest
      .filter((review) => buyerById.has(review.buyerId))
      .slice(0, limit)
      .map((review) => {
        const buyer = buyerById.get(review.buyerId)!;
        return {
          id: review.id,
          rating: review.rating,
          body: review.body,
          createdAt: review.createdAt,
          firstName: buyer.firstName,
          lastName: buyer.lastName,
          location: buyer.location,
          region: buyer.region,
          avatarUrl: buyer.avatarUrl,
          title: titleByOrder.get(review.orderId) ?? null,
        };
      });
    return rows.map((row) => {
      const place = [row.location, row.region].filter((value): value is string => Boolean(value));
      return {
        id: row.id,
        rating: row.rating,
        title: row.title || 'Verified purchase',
        body: row.body,
        author: `${row.firstName} ${row.lastName ? `${row.lastName[0]}.` : ''}`.trim(),
        location: place.length ? Array.from(new Set(place)).join(', ') : null,
        avatar: row.avatarUrl,
        at: row.createdAt.toISOString(),
      };
    });
  }

  /** The seller's public reply under a review. */
  async reply(user: AuthUser, reviewId: string, body: string): Promise<ReviewView> {
    const updated = isUuid(reviewId)
      ? await this.db.update(reviews, { id: reviewId, sellerId: user.id, hidden: false }, { response: { body, at: new Date().toISOString() } })
      : null;
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
    const updated = isUuid(reviewId) ? await this.db.update(reviews, { id: reviewId }, { hidden }) : null;
    if (!updated) throw Errors.notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
    await this.recompute(updated.sellerId, await this.productIdsOf(updated.orderId));
    await this.audit.record(staff, { action: hidden ? 'Hid a review' : 'Restored a review', target: updated.body.slice(0, 60) || `${updated.rating}-star review`, targetType: 'review', targetId: reviewId });
    return (await this.views([updated]))[0];
  }
}
