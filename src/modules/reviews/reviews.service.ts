import { Injectable } from '@nestjs/common';
import { and, avg, count, desc, eq, exists, gte, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { REVIEW_ASPECTS, REVIEW_ASPECT_LABEL, type ReviewAspect } from '../../common/domain';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { orderItems, orders, products, reviews, users } from '../../database/schema';
import { isUniqueViolation } from '../../database/sql';
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

/** Reviews of orders that included the product (a review covers its order's items). */
function aboutProduct(productId: string): SQL {
  return exists(
    sql`(select 1 from ${orderItems} where ${orderItems.orderId} = ${reviews.orderId} and ${orderItems.productId} = ${productId})`,
  );
}

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
      this.db
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, avatarUrl: users.avatarUrl })
        .from(users)
        .where(
          inArray(
            users.id,
            rows.map((row) => row.buyerId),
          ),
        ),
      this.db
        .select({ id: orders.id, reference: orders.reference })
        .from(orders)
        .where(
          inArray(
            orders.id,
            rows.map((row) => row.orderId),
          ),
        ),
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
    const rows = await this.db.select({ productId: orderItems.productId }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.position);
    return rows.map((row) => row.productId);
  }

  /** "Write a review" on a completed order (escrow released). One per order. */
  async create(user: AuthUser, orderIdOrReference: string, input: { rating: number; aspects?: Partial<Record<ReviewAspect, number>>; body?: string }): Promise<ReviewView> {
    const reference = orderIdOrReference.replace(/^#/, '');
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(isUuid(reference) ? eq(orders.id, reference) : eq(orders.reference, reference), eq(orders.buyerId, user.id)));
    if (!order) throw Errors.notFound("We couldn't find that order.", 'ORDER_NOT_FOUND');
    if (order.escrowPhase !== 'released') throw Errors.conflict('You can review an order once it is complete.', 'ORDER_NOT_COMPLETE');
    if (order.reviewId) throw Errors.conflict('You have already reviewed this order.', 'ALREADY_REVIEWED');
    let created: Review;
    try {
      created = await this.db.transaction(async (tx) => {
        const [review] = await tx
          .insert(reviews)
          .values({ orderId: order.id, buyerId: order.buyerId, sellerId: order.sellerId, rating: input.rating, aspects: input.aspects ?? {}, body: input.body?.trim() ?? '' })
          .returning();
        await tx.update(orders).set({ reviewId: review.id }).where(eq(orders.id, order.id));
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
    const [seller] = await this.db
      .select({ average: avg(reviews.rating).mapWith(Number), total: count() })
      .from(reviews)
      .where(and(eq(reviews.sellerId, sellerId), eq(reviews.hidden, false)));
    await this.db
      .update(users)
      .set({ statsRatingAverage: round1(seller?.average ?? 0), statsRatingCount: seller?.total ?? 0 })
      .where(eq(users.id, sellerId));
    for (const productId of productIds) {
      const [product] = await this.db
        .select({ average: avg(reviews.rating).mapWith(Number), total: count() })
        .from(reviews)
        .where(and(aboutProduct(productId), eq(reviews.hidden, false)));
      await this.db
        .update(products)
        .set({ statsRatingAverage: round1(product?.average ?? 0), statsRatingCount: product?.total ?? 0 })
        .where(eq(products.id, productId));
    }
  }

  /** The Ratings page's summary cards: average, distribution and per-aspect scores. */
  async summary(sellerId: string): Promise<RatingSummary> {
    const visible = and(eq(reviews.sellerId, sellerId), eq(reviews.hidden, false));
    const aspectAverages = Object.fromEntries(
      REVIEW_ASPECTS.map((key) => [key, sql<number | null>`avg((${reviews.aspects}->>${key})::numeric)`.mapWith(Number)]),
    ) as Record<ReviewAspect, SQL.Aliased<number | null> | SQL<number | null>>;
    const [[totals], distribution] = await Promise.all([
      this.db
        .select({ average: avg(reviews.rating).mapWith(Number), total: count(), ...aspectAverages })
        .from(reviews)
        .where(visible),
      this.db.select({ stars: reviews.rating, count: count() }).from(reviews).where(visible).groupBy(reviews.rating),
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

  private async pageOf(where: SQL, page: number, limit: number): Promise<Page<ReviewView>> {
    const [{ total }] = await this.db.select({ total: count() }).from(reviews).where(where);
    const window = pageWindow(total, page, limit);
    const rows = await this.db.select().from(reviews).where(where).orderBy(desc(reviews.createdAt), desc(reviews.id)).offset(window.skip).limit(window.size);
    return toPage(await this.views(rows), total, window);
  }

  async forSeller(sellerId: string, page = 1, limit = 10): Promise<Page<ReviewView>> {
    if (!isUuid(sellerId)) return toPage([], 0, pageWindow(0, 1, limit));
    return this.pageOf(and(eq(reviews.sellerId, sellerId), eq(reviews.hidden, false))!, page, limit);
  }

  async forProduct(productId: string, page = 1, limit = 10): Promise<Page<ReviewView>> {
    if (!isUuid(productId)) return toPage([], 0, pageWindow(0, 1, limit));
    return this.pageOf(and(aboutProduct(productId), eq(reviews.hidden, false))!, page, limit);
  }

  /**
   * Recent 4–5 star reviews with something to say, at most one per buyer,
   * for the landing page. Only real reviews from paid orders appear.
   */
  async highlights(limit = 3): Promise<ReviewHighlight[]> {
    const latestPerBuyer = this.db
      .selectDistinctOn([reviews.buyerId])
      .from(reviews)
      .where(and(eq(reviews.hidden, false), gte(reviews.rating, 4), sql`char_length(${reviews.body}) >= 40`))
      .orderBy(reviews.buyerId, desc(reviews.rating), desc(reviews.createdAt))
      .as('latest');
    const rows = await this.db
      .select({
        id: latestPerBuyer.id,
        rating: latestPerBuyer.rating,
        body: latestPerBuyer.body,
        createdAt: latestPerBuyer.createdAt,
        firstName: users.firstName,
        lastName: users.lastName,
        location: users.location,
        region: users.region,
        avatarUrl: users.avatarUrl,
        title: sql<string | null>`(select ${orderItems.title} from ${orderItems} where ${orderItems.orderId} = ${latestPerBuyer.orderId} order by ${orderItems.position} limit 1)`,
      })
      .from(latestPerBuyer)
      .innerJoin(users, and(eq(users.id, latestPerBuyer.buyerId), ne(users.status, 'closed')))
      .orderBy(desc(latestPerBuyer.rating), desc(latestPerBuyer.createdAt))
      .limit(limit);
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
    const [updated] = isUuid(reviewId)
      ? await this.db
          .update(reviews)
          .set({ response: { body, at: new Date().toISOString() } })
          .where(and(eq(reviews.id, reviewId), eq(reviews.sellerId, user.id), eq(reviews.hidden, false)))
          .returning()
      : [];
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
    const [updated] = isUuid(reviewId) ? await this.db.update(reviews).set({ hidden }).where(eq(reviews.id, reviewId)).returning() : [];
    if (!updated) throw Errors.notFound('That review does not exist.', 'REVIEW_NOT_FOUND');
    await this.recompute(updated.sellerId, await this.productIdsOf(updated.orderId));
    await this.audit.record(staff, { action: hidden ? 'Hid a review' : 'Restored a review', target: updated.body.slice(0, 60) || `${updated.rating}-star review`, targetType: 'review', targetId: reviewId });
    return (await this.views([updated]))[0];
  }
}
