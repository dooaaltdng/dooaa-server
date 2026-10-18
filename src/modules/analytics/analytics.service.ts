import { Injectable, OnModuleInit } from '@nestjs/common';
import { and, count, eq, gte, inArray, isNull, lt, lte, ne, sql, sum, type SQL } from 'drizzle-orm';
import type { StatScope } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { dayKey, startOfLagosDay, TIME_ZONE } from '../../common/util/dates';
import { formatNairaCompact } from '../../common/util/money';
import { InjectDb, type Database } from '../../database/database';
import { dailyStats, orders, products, users, visitorDays } from '../../database/schema';
import { PRODUCT_EVENTS, type ProductViewed } from '../products/products.service';
import { buildBuckets, compactCount, fold, percentChange, type RangeId } from './buckets';

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const RANGE_LABEL: Record<RangeId, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months' };
const BADGE_LABEL: Record<RangeId, string> = { '7d': 'Last 7 Days', '30d': 'Last 30 Days', '90d': 'Last 90 Days', '12m': 'Last 12 Months' };

export type TrendId = 'transactions' | 'activity';

@Injectable()
export class AnalyticsService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<ProductViewed>(PRODUCT_EVENTS.viewed, (event) => this.recordProductView(event.sellerId));
  }

  /** Adds to a day's counters, creating the row on the day's first count. */
  private async bumpDay(scope: StatScope, sellerId: string | null, day: string, field: 'visits' | 'productViews'): Promise<void> {
    await this.db
      .insert(dailyStats)
      .values({ scope, sellerId, day, [field]: 1 })
      .onConflictDoUpdate({
        target: [dailyStats.scope, dailyStats.sellerId, dailyStats.day],
        set: { [field]: sql`${dailyStats[field]} + 1` },
      });
  }

  /** One visit per visitor per Lagos day. */
  async recordVisit(visitorId: string): Promise<{ counted: boolean }> {
    const day = dayKey();
    const inserted = await this.db
      .insert(visitorDays)
      .values({ visitorId, day })
      .onConflictDoNothing()
      .returning({ visitorId: visitorDays.visitorId });
    if (!inserted.length) return { counted: false };
    await this.bumpDay('site', null, day, 'visits');
    return { counted: true };
  }

  async recordProductView(sellerId: string): Promise<void> {
    const day = dayKey();
    await Promise.all([this.bumpDay('seller', sellerId, day, 'productViews'), this.bumpDay('site', null, day, 'productViews')]);
  }

  /** Paid amounts grouped by Lagos day (or month). */
  private async moneyByKey(match: SQL | undefined, from: Date, to: Date, field: 'total' | 'sellerEarning', monthly: boolean): Promise<Map<string, number>> {
    // Constants inlined (not bound): GROUP BY must see the very same expression as the select list.
    const key = sql<string>`to_char(${orders.paymentPaidAt} at time zone '${sql.raw(TIME_ZONE)}', '${sql.raw(monthly ? 'YYYY-MM' : 'YYYY-MM-DD')}')`;
    const rows = await this.db
      .select({ key, amount: sum(orders[field]).mapWith(Number) })
      .from(orders)
      .where(and(match, eq(orders.paymentStatus, 'paid'), gte(orders.paymentPaidAt, from), lte(orders.paymentPaidAt, to)))
      .groupBy(key);
    return new Map(rows.map((row) => [row.key, row.amount ?? 0]));
  }

  private async countsByKey(field: 'visits' | 'productViews', scope: StatScope, sellerId: string | null, fromDay: string, monthly: boolean): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ day: dailyStats.day, value: dailyStats[field] })
      .from(dailyStats)
      .where(and(eq(dailyStats.scope, scope), sellerId ? eq(dailyStats.sellerId, sellerId) : isNull(dailyStats.sellerId), gte(dailyStats.day, fromDay)));
    const out = new Map<string, number>();
    for (const row of rows) {
      const key = monthly ? row.day.slice(0, 7) : row.day;
      out.set(key, (out.get(key) ?? 0) + row.value);
    }
    return out;
  }

  private async countOf(table: typeof users | typeof products | typeof orders, where: SQL | undefined): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(table).where(where);
    return row.total;
  }

  /** Seller Analytics: revenue against the previous period, orders by status and store views. */
  async sellerAnalytics(sellerId: string, range: '7d' | '30d' | '12m') {
    const monthly = range === '12m';
    const { current, previous, from, previousFrom, to } = buildBuckets(range, new Date());
    const [money, views, statuses] = await Promise.all([
      this.moneyByKey(eq(orders.sellerId, sellerId), previousFrom, to, 'sellerEarning', monthly),
      this.countsByKey('productViews', 'seller', sellerId, dayKey(previousFrom), monthly),
      this.db
        .select({ status: orders.status, count: count() })
        .from(orders)
        .where(and(eq(orders.sellerId, sellerId), eq(orders.paymentStatus, 'paid'), gte(orders.paymentPaidAt, from)))
        .groupBy(orders.status),
    ]);
    const currentRevenue = fold(current, money);
    const previousRevenue = fold(previous, money);
    const byStatus = new Map<string, number>(statuses.map((row) => [row.status, row.count]));
    const totalRevenue = currentRevenue.reduce((sum, value) => sum + value, 0);
    const lastRevenue = previousRevenue.reduce((sum, value) => sum + value, 0);
    const totalViews = fold(current, views).reduce((sum, value) => sum + value, 0);
    const orderCount = [...byStatus.values()].reduce((sum, value) => sum + value, 0);
    return {
      range,
      rangeLabel: RANGE_LABEL[range],
      revenue: current.map((bucket, index) => ({ label: bucket.label, date: bucket.date, current: currentRevenue[index], previous: previousRevenue[index] })),
      ordersByStatus: [
        { status: 'delivered', count: byStatus.get('delivered') ?? 0 },
        { status: 'shipped', count: byStatus.get('shipped') ?? 0 },
        { status: 'cancelled', count: byStatus.get('cancelled') ?? 0 },
      ],
      views: totalViews,
      totals: {
        revenue: Math.round(totalRevenue * 100) / 100,
        previousRevenue: Math.round(lastRevenue * 100) / 100,
        change: percentChange(totalRevenue, lastRevenue),
        orders: orderCount,
        conversionRate: totalViews > 0 ? Math.round((orderCount / totalViews) * 1000) / 10 : 0,
      },
    };
  }

  /** The four stat tiles, with this month's growth. */
  async dashboardMetrics() {
    const monthStart = new Date(`${dayKey().slice(0, 7)}-01T00:00:00+01:00`);
    const lastMonthStart = new Date(monthStart.getTime());
    lastMonthStart.setUTCMonth(lastMonthStart.getUTCMonth() - 1);
    const people = and(ne(users.email, OFFICIAL_STORE_EMAIL), ne(users.status, 'closed'));
    // Accounts without a role yet count as buyers, as on the storefront.
    const buyer = sql`${users.role} is distinct from 'seller'`;
    const live = and(eq(products.status, 'active'), isNull(products.deletedAt));
    const [buyers, buyersNew, sellers, sellersNew, items, itemsNew, active, fundedThis, fundedLast] = await Promise.all([
      this.countOf(users, and(people, buyer)),
      this.countOf(users, and(people, buyer, gte(users.createdAt, monthStart))),
      this.countOf(users, and(people, eq(users.role, 'seller'))),
      this.countOf(users, and(people, eq(users.role, 'seller'), gte(users.createdAt, monthStart))),
      this.countOf(products, live),
      this.countOf(products, and(live, gte(products.publishedAt, monthStart))),
      this.countOf(orders, inArray(orders.escrowStatus, ['pending', 'dispute'])),
      this.countOf(orders, gte(orders.escrowFundedAt, monthStart)),
      this.countOf(orders, and(gte(orders.escrowFundedAt, lastMonthStart), lt(orders.escrowFundedAt, monthStart))),
    ]);
    const growth = (total: number, added: number) => percentChange(total, total - added);
    return [
      { id: 'buyers', label: 'Total Buyers', value: buyers, delta: growth(buyers, buyersNew), deltaSuffix: 'this month' },
      { id: 'sellers', label: 'Total Sellers', value: sellers, delta: growth(sellers, sellersNew), deltaSuffix: 'this month' },
      { id: 'items', label: 'Total Items', value: items, delta: growth(items, itemsNew), deltaSuffix: 'this month' },
      { id: 'transactions', label: 'Active Transaction', value: active, delta: percentChange(fundedThis, fundedLast) },
    ];
  }

  /** A trend card: transaction volume or site activity, this period against the last. */
  async trend(id: TrendId, range: '7d' | '30d' | '90d') {
    const { current, previous, previousFrom, to } = buildBuckets(range, new Date());
    const values =
      id === 'transactions'
        ? await this.moneyByKey(undefined, previousFrom, to, 'total', false)
        : await this.countsByKey('visits', 'site', null, dayKey(previousFrom), false);
    const currentPoints = fold(current, values);
    const previousPoints = fold(previous, values);
    const now = currentPoints.reduce((sum, value) => sum + value, 0);
    const before = previousPoints.reduce((sum, value) => sum + value, 0);
    const change = percentChange(now, before);
    return {
      id,
      title: id === 'transactions' ? 'Transaction Volume' : 'Site Activity',
      headline: id === 'transactions' ? formatNairaCompact(now) : `${compactCount(now)} Visits`,
      badge: `${BADGE_LABEL[range]} ${change >= 0 ? '+' : ''}${change}%`,
      unit: id === 'transactions' ? 'money' : 'count',
      scale: 1,
      total: Math.round(now * 100) / 100,
      previousTotal: Math.round(before * 100) / 100,
      change,
      points: current.map((bucket, index) => ({ bucket: bucket.label, date: bucket.date, current: currentPoints[index], previous: previousPoints[index] })),
    };
  }

  /** Housekeeping for tests and reports: today's site counters. */
  async today() {
    const [row] = await this.db
      .select({ visits: dailyStats.visits, productViews: dailyStats.productViews })
      .from(dailyStats)
      .where(and(eq(dailyStats.scope, 'site'), isNull(dailyStats.sellerId), eq(dailyStats.day, dayKey(startOfLagosDay()))));
    return { visits: row?.visits ?? 0, productViews: row?.productViews ?? 0 };
  }
}
