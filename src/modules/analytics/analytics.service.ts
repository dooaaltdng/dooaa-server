import { Injectable, OnModuleInit } from '@nestjs/common';
import type { StatScope } from '../../common/domain';
import { EventBus } from '../../common/events/event-bus';
import { dayKey, startOfLagosDay, TIME_ZONE } from '../../common/util/dates';
import { formatNairaCompact } from '../../common/util/money';
import { InjectDb, isUniqueViolation, type Database, type Table, type Where } from '../../database/database';
import { dailyStats, type OrderRow, orders, products, trafficSources, users, visitLocations, visitorDays } from '../../database/schema';
import { PRODUCT_EVENTS, type ProductViewed } from '../products/products.service';
import { buildBuckets, compactCount, fold, percentChange, type RangeId } from './buckets';
import { GeoService, type GeoPlace } from './geo.service';
import { classifyTraffic, TRAFFIC_LABEL, TRAFFIC_SOURCES, type TrafficSource } from './traffic';
import { InjectConfig } from '../../config/config.module';
import type { AppConfig } from '../../config/configuration';
import { RealtimeService } from '../realtime/realtime.service';
import { userOmit } from '../users/user.model';

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const RANGE_LABEL: Record<RangeId, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months', year: 'This year' };
const BADGE_LABEL: Record<RangeId, string> = { '7d': 'Last 7 Days', '30d': 'Last 30 Days', '90d': 'Last 90 Days', '12m': 'Last 12 Months', year: 'This Year' };

export type TrendId = 'transactions' | 'activity';

/** What the storefront knows about how a visit arrived; see traffic.ts. */
export type VisitOrigin = { referrer?: string | null; utmSource?: string | null; utmMedium?: string | null; userAgent?: string | null };

@Injectable()
export class AnalyticsService implements OnModuleInit {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly events: EventBus,
    private readonly geo: GeoService,
    private readonly realtime: RealtimeService,
    @InjectConfig() private readonly config: AppConfig,
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
  async recordVisit(visitorId: string, ip?: string, origin: VisitOrigin = {}): Promise<{ counted: boolean }> {
    const day = dayKey();
    const inserted = await this.db.insertIgnoringDuplicates(visitorDays, [{ visitorId, day }]);
    if (!inserted) return { counted: false };
    await this.bumpDay('site', null, day, 'visits');
    const place = this.geo.lookup(ip);
    if (place) await this.bumpPlace(day, place).catch(() => undefined);
    const source = classifyTraffic({ ...origin, ownHosts: this.ownHosts() });
    await this.bumpSource(day, source).catch(() => undefined);
    // Lets an open dashboard tick the Traffic Sources card up straight away.
    this.realtime.toAllStaff('analytics:visit', { source, city: place?.city ?? null });
    return { counted: true };
  }

  /** The storefront's own hosts, so moving between its pages is not a referral. */
  private ownHosts(): string[] {
    const hosts = ['localhost', '127.0.0.1'];
    try {
      hosts.push(new URL(this.config.platformUrl).hostname);
    } catch {
      // A bad PLATFORM_URL is caught at boot; nothing to add here.
    }
    return hosts;
  }

  private async bumpSource(day: string, source: TrafficSource): Promise<void> {
    const bump = () => this.db.upsert(trafficSources, { day, source }, { $inc: { visits: 1 } });
    await bump().catch((error) => (isUniqueViolation(error) ? bump() : Promise.reject(error)));
  }

  /** Visits by where they came from over a range, busiest first (every source listed, zeros included). */
  async trafficSourcesReport(range: 'today' | '7d' | '30d' | '90d') {
    const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 91;
    const fromDay = dayKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
    const rows = await this.db.aggregate<{ _id: string; visits: number }>(trafficSources, [
      { $match: { day: { $gte: fromDay } } },
      { $group: { _id: '$source', visits: { $sum: '$visits' } } },
    ]);
    const counts = new Map<string, number>();
    for (const row of rows) {
      // "direct" was its own source before 2026-11-15; it now counts as Other.
      const id = row._id === 'direct' ? 'other' : row._id;
      counts.set(id, (counts.get(id) ?? 0) + (row.visits ?? 0));
    }
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const sources = TRAFFIC_SOURCES.map((id) => {
      const visits = counts.get(id) ?? 0;
      return { id, label: TRAFFIC_LABEL[id], visits, share: total ? Math.round((visits / total) * 1000) / 10 : 0 };
    }).sort((a, b) => b.visits - a.visits);
    return { range, total, sources };
  }

  /** The newest sign-ups for the dashboard, buyer or seller. */
  async recentSignups(limit: number) {
    const rows = await this.db.find(
      users,
      { email: { $ne: OFFICIAL_STORE_EMAIL } },
      { sort: { createdAt: -1, id: -1 }, limit, omit: userOmit },
    );
    return rows.map((user) => ({
      id: user.id,
      name: `${user.firstName} ${user.lastName}`.trim() || user.email,
      email: user.email,
      role: user.role === 'seller' ? ('seller' as const) : ('buyer' as const),
      avatar: user.avatarUrl,
      joinedAt: user.createdAt,
    }));
  }

  /** One more visit for a place on a day; the IP that located it is not kept. */
  private async bumpPlace(day: string, place: GeoPlace): Promise<void> {
    const key = { day, countryCode: place.countryCode, city: place.city };
    const bump = () =>
      this.db.upsert(visitLocations, key, { $inc: { visits: 1 } }, { country: place.country, region: place.region, lat: place.lat, lng: place.lng });
    await bump().catch((error) => (isUniqueViolation(error) ? bump() : Promise.reject(error)));
  }

  /**
   * The dashboard map: the busiest places over a range, by city or rolled up
   * by country (a country's pin sits at its visit-weighted centre).
   */
  async locations(range: '7d' | '30d' | '90d', group: 'city' | 'country') {
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 91;
    const fromDay = dayKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));
    const rows = await this.db.aggregate<{ _id: Record<string, string>; country: string; visits: number; latSum: number; lngSum: number }>(visitLocations, [
      { $match: { day: { $gte: fromDay } } },
      {
        $group: {
          _id: group === 'city' ? { countryCode: '$countryCode', city: '$city' } : { countryCode: '$countryCode' },
          country: { $first: '$country' },
          visits: { $sum: '$visits' },
          latSum: { $sum: { $multiply: ['$lat', '$visits'] } },
          lngSum: { $sum: { $multiply: ['$lng', '$visits'] } },
        },
      },
      { $sort: { visits: -1 } },
      { $limit: 60 },
    ]);
    const site = await this.countsByKey('visits', 'site', null, fromDay, false);
    const total = [...site.values()].reduce((sum, value) => sum + value, 0);
    const places = rows.map((row) => {
      const visits = row.visits || 0;
      const id = group === 'city' ? `${row._id.countryCode}:${row._id.city}` : row._id.countryCode;
      return {
        id,
        name: group === 'city' ? row._id.city : row.country,
        country: row.country,
        countryCode: row._id.countryCode,
        lat: visits ? Math.round((row.latSum / visits) * 10_000) / 10_000 : 0,
        lng: visits ? Math.round((row.lngSum / visits) * 10_000) / 10_000 : 0,
        visits,
      };
    });
    return { range, group, total, located: places.reduce((sum, place) => sum + place.visits, 0), places };
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

  /**
   * Analytics page: all users, sellers and buyers — totals, accounts active in
   * the last 30 days (by last login) and new sign-ups for each of the last six
   * Lagos months. Same population rules as dashboardMetrics.
   */
  async audiences() {
    const people = { email: { $ne: OFFICIAL_STORE_EMAIL }, status: { $ne: 'closed' } };
    const groups = [
      { id: 'all', label: 'All Users', where: people },
      { id: 'sellers', label: 'Sellers', where: { ...people, role: 'seller' } },
      { id: 'buyers', label: 'Buyers', where: { ...people, role: { $ne: 'seller' } } },
    ];
    const thisMonth = dayKey().slice(0, 7);
    const months: string[] = [];
    for (let back = 5; back >= 0; back--) {
      const d = new Date(`${thisMonth}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - back);
      months.push(d.toISOString().slice(0, 7));
    }
    const from = new Date(`${months[0]}-01T00:00:00+01:00`);
    const activeSince = new Date(Date.now() - 30 * 86_400_000);
    const label = (key: string) => new Date(`${key}-15T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' });

    return Promise.all(
      groups.map(async (group) => {
        const [total, active, rows] = await Promise.all([
          this.countOf(users, group.where),
          this.countOf(users, { ...group.where, lastLoginAt: { $gte: activeSince } }),
          this.db.aggregate<{ _id: string; count: number }>(users, [
            { $match: { ...group.where, createdAt: { $gte: from } } },
            { $group: { _id: { $dateToString: { date: '$createdAt', format: '%Y-%m', timezone: TIME_ZONE } }, count: { $sum: 1 } } },
          ]),
        ]);
        const byMonth = new Map(rows.map((row) => [row._id, row.count]));
        return {
          id: group.id,
          label: group.label,
          total,
          active,
          monthly: months.map((key) => ({ month: key, label: label(key), signups: byMonth.get(key) ?? 0 })),
        };
      }),
    );
  }

  /** A trend card: transaction volume or site activity, this period against the last. */
  async trend(id: TrendId, range: RangeId) {
    const { current, previous, previousFrom, to } = buildBuckets(range, new Date());
    // Year and 12-month views are one bar per month; the rest are per day (or week).
    const monthly = range === 'year' || range === '12m';
    const values =
      id === 'transactions'
        ? await this.moneyByKey({}, previousFrom, to, 'total', monthly)
        : await this.countsByKey('visits', 'site', null, dayKey(previousFrom), monthly);
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
