import { Injectable, OnModuleInit } from '@nestjs/common';
import type { StatScope } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { dayKey, startOfLagosDay, TIME_ZONE } from '../../common/util/dates';
import { formatNairaCompact } from '../../common/util/money';
import { InjectDb, isUniqueViolation, type Database, type Table, type Where } from '../../database/database';
import { dailyStats, orders, products, users, visitorDays, type OrderRow } from '../../database/schema';
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
    const bump = () => this.db.upsert(dailyStats, { scope, sellerId, day }, { $inc: { [field]: 1 } });
    // Two first counts of a day can race to create the row; the loser just increments it.
    await bump().catch((error) => (isUniqueViolation(error) ? bump() : Promise.reject(error)));
  }

  /** One visit per visitor per Lagos day. */
  async recordVisit(visitorId: string): Promise<{ counted: boolean }> {
    const day = dayKey();
    const inserted = await this.db.insertIgnoringDuplicates(visitorDays, [{ visitorId, day }]);
    if (!inserted) return { counted: false };
    await this.bumpDay('site', null, day, 'visits');
    return { counted: true };
  }

  async recordProductView(sellerId: string): Promise<void> {
    const day = dayKey();
    await Promise.all([this.bumpDay('seller', sellerId, day, 'productViews'), this.bumpDay('site', null, day, 'productViews')]);
  }

  /** Paid amounts grouped by Lagos day (or month). */
  private async moneyByKey(match: Where<OrderRow>, from: Date, to: Date, field: 'total' | 'sellerEarning', monthly: boolean): Promise<Map<string, number>> {
    const rows = await this.db.aggregate<{ _id: string; amount: number }>(orders, [
      { $match: { ...match, paymentStatus: 'paid', paymentPaidAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: { $dateToString: { date: '$paymentPaidAt', format: monthly ? '%Y-%m' : '%Y-%m-%d', timezone: TIME_ZONE } },
          amount: { $sum: `$${field}` },
        },
      },
    ]);
    return new Map(rows.map((row) => [row._id, row.amount ?? 0]));
  }

  private async countsByKey(field: 'visits' | 'productViews', scope: StatScope, sellerId: string | null, fromDay: string, monthly: boolean): Promise<Map<string, number>> {
    const rows = await this.db.find(dailyStats, { scope, sellerId, day: { $gte: fromDay } });
    const out = new Map<string, number>();
    for (const row of rows) {
      const key = monthly ? row.day.slice(0, 7) : row.day;
      out.set(key, (out.get(key) ?? 0) + row[field]);
    }
    return out;
  }

  private countOf(table: Table, where: Where<any>): Promise<number> {
    return this.db.count(table, where);
  }

  /** Seller Analytics: revenue against the previous period, orders by status and store views. */
  async sellerAnalytics(sellerId: string, range: '7d' | '30d' | '12m') {
    const monthly = range === '12m';
    const { current, previous, from, previousFrom, to } = buildBuckets(range, new Date());
    const [money, views, statuses] = await Promise.all([
      this.moneyByKey({ sellerId }, previousFrom, to, 'sellerEarning', monthly),
      this.countsByKey('productViews', 'seller', sellerId, dayKey(previousFrom), monthly),
      this.db.aggregate<{ status: string; count: number }>(orders, [
        { $match: { sellerId, paymentStatus: 'paid', paymentPaidAt: { $gte: from } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $project: { _id: 0, status: '$_id', count: 1 } },
      ]),
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
    const people = { email: { $ne: OFFICIAL_STORE_EMAIL }, status: { $ne: 'closed' } };
    // Accounts without a role yet count as buyers, as on the storefront.
    const buyer = { ...people, role: { $ne: 'seller' } };
    const seller = { ...people, role: 'seller' };
    const live = { status: 'active', deletedAt: null };
    const [buyers, buyersNew, sellers, sellersNew, items, itemsNew, active, fundedThis, fundedLast] = await Promise.all([
      this.countOf(users, buyer),
      this.countOf(users, { ...buyer, createdAt: { $gte: monthStart } }),
      this.countOf(users, seller),
      this.countOf(users, { ...seller, createdAt: { $gte: monthStart } }),
      this.countOf(products, live),
      this.countOf(products, { ...live, publishedAt: { $gte: monthStart } }),
      this.countOf(orders, { escrowStatus: { $in: ['pending', 'dispute'] } }),
      this.countOf(orders, { escrowFundedAt: { $gte: monthStart } }),
      this.countOf(orders, { escrowFundedAt: { $gte: lastMonthStart, $lt: monthStart } }),
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
        ? await this.moneyByKey({}, previousFrom, to, 'total', false)
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
    const row = await this.db.findOne(dailyStats, { scope: 'site', sellerId: null, day: dayKey(startOfLagosDay()) });
    return { visits: row?.visits ?? 0, productViews: row?.productViews ?? 0 };
  }
}
