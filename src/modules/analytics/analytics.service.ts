import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventBus } from '../../common/events/event-bus';
import { dayKey, startOfLagosDay } from '../../common/util/dates';
import { formatNairaCompact } from '../../common/util/money';
import { Order } from '../orders/schemas/order.schema';
import { PRODUCT_EVENTS, type ProductViewed } from '../products/products.service';
import { Product } from '../products/schemas/product.schema';
import { User } from '../users/schemas/user.schema';
import { DailyStat, VisitorDay } from './analytics.schema';
import { buildBuckets, compactCount, fold, percentChange, type RangeId } from './buckets';

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const RANGE_LABEL: Record<RangeId, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '12m': 'Last 12 months' };
const BADGE_LABEL: Record<RangeId, string> = { '7d': 'Last 7 Days', '30d': 'Last 30 Days', '90d': 'Last 90 Days', '12m': 'Last 12 Months' };

export type TrendId = 'transactions' | 'activity';

@Injectable()
export class AnalyticsService implements OnModuleInit {
  constructor(
    @InjectModel(DailyStat.name) private readonly stats: Model<DailyStat>,
    @InjectModel(VisitorDay.name) private readonly visitors: Model<VisitorDay>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<ProductViewed>(PRODUCT_EVENTS.viewed, (event) => this.recordProductView(event.sellerId));
  }

  /** One visit per visitor per Lagos day. */
  async recordVisit(visitorId: string): Promise<{ counted: boolean }> {
    const day = dayKey();
    const result = await this.visitors.updateOne({ visitorId, day }, { $setOnInsert: { at: new Date() } }, { upsert: true });
    if (!result.upsertedCount) return { counted: false };
    await this.stats.updateOne({ scope: 'site', sellerId: null, day }, { $inc: { visits: 1 } }, { upsert: true });
    return { counted: true };
  }

  async recordProductView(sellerId: string): Promise<void> {
    const day = dayKey();
    await Promise.all([
      this.stats.updateOne({ scope: 'seller', sellerId: new Types.ObjectId(sellerId), day }, { $inc: { productViews: 1 } }, { upsert: true }),
      this.stats.updateOne({ scope: 'site', sellerId: null, day }, { $inc: { productViews: 1 } }, { upsert: true }),
    ]);
  }

  /** Paid amounts grouped by Lagos day (or month). */
  private async moneyByKey(match: Record<string, unknown>, from: Date, to: Date, field: '$total' | '$sellerEarning', monthly: boolean): Promise<Map<string, number>> {
    const rows = await this.orders.aggregate<{ _id: string; amount: number }>([
      { $match: { ...match, 'payment.status': 'paid', 'payment.paidAt': { $gte: from, $lte: to } } },
      { $group: { _id: { $dateToString: { format: monthly ? '%Y-%m' : '%Y-%m-%d', date: '$payment.paidAt', timezone: 'Africa/Lagos' } }, amount: { $sum: field } } },
    ]);
    return new Map(rows.map((row) => [row._id, row.amount]));
  }

  private async countsByKey(field: 'visits' | 'productViews', scope: 'site' | 'seller', sellerId: Types.ObjectId | null, fromDay: string, monthly: boolean): Promise<Map<string, number>> {
    const rows = await this.stats.find({ scope, sellerId, day: { $gte: fromDay } }).select(`day ${field}`).lean();
    const out = new Map<string, number>();
    for (const row of rows) {
      const key = monthly ? row.day.slice(0, 7) : row.day;
      out.set(key, (out.get(key) ?? 0) + (row[field] ?? 0));
    }
    return out;
  }

  /** Seller Analytics: revenue against the previous period, orders by status and store views. */
  async sellerAnalytics(sellerId: string, range: '7d' | '30d' | '12m') {
    const owner = new Types.ObjectId(sellerId);
    const monthly = range === '12m';
    const { current, previous, from, previousFrom, to } = buildBuckets(range, new Date());
    const [money, views, statuses] = await Promise.all([
      this.moneyByKey({ sellerId: owner }, previousFrom, to, '$sellerEarning', monthly),
      this.countsByKey('productViews', 'seller', owner, dayKey(previousFrom), monthly),
      this.orders.aggregate<{ _id: string; count: number }>([
        { $match: { sellerId: owner, 'payment.status': 'paid', 'payment.paidAt': { $gte: from } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);
    const currentRevenue = fold(current, money);
    const previousRevenue = fold(previous, money);
    const byStatus = new Map(statuses.map((row) => [row._id, row.count]));
    const totalRevenue = currentRevenue.reduce((sum, value) => sum + value, 0);
    const lastRevenue = previousRevenue.reduce((sum, value) => sum + value, 0);
    const totalViews = fold(current, views).reduce((sum, value) => sum + value, 0);
    const orders = [...byStatus.values()].reduce((sum, value) => sum + value, 0);
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
        orders,
        conversionRate: totalViews > 0 ? Math.round((orders / totalViews) * 1000) / 10 : 0,
      },
    };
  }

  /** The four stat tiles, with this month's growth. */
  async dashboardMetrics() {
    const monthStart = new Date(`${dayKey().slice(0, 7)}-01T00:00:00+01:00`);
    const lastMonthStart = new Date(monthStart.getTime());
    lastMonthStart.setUTCMonth(lastMonthStart.getUTCMonth() - 1);
    const people = { email: { $ne: OFFICIAL_STORE_EMAIL }, status: { $ne: 'closed' as const } };
    const [buyers, buyersNew, sellers, sellersNew, items, itemsNew, active, fundedThis, fundedLast] = await Promise.all([
      this.users.countDocuments({ ...people, role: { $ne: 'seller' } }),
      this.users.countDocuments({ ...people, role: { $ne: 'seller' }, createdAt: { $gte: monthStart } }),
      this.users.countDocuments({ ...people, role: 'seller' }),
      this.users.countDocuments({ ...people, role: 'seller', createdAt: { $gte: monthStart } }),
      this.products.countDocuments({ status: 'active', deletedAt: null }),
      this.products.countDocuments({ status: 'active', deletedAt: null, publishedAt: { $gte: monthStart } }),
      this.orders.countDocuments({ 'escrow.status': { $in: ['pending', 'dispute'] } }),
      this.orders.countDocuments({ 'escrow.fundedAt': { $gte: monthStart } }),
      this.orders.countDocuments({ 'escrow.fundedAt': { $gte: lastMonthStart, $lt: monthStart } }),
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
        ? await this.moneyByKey({}, previousFrom, to, '$total', false)
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
    const row = await this.stats.findOne({ scope: 'site', sellerId: null, day: dayKey(startOfLagosDay()) }).lean();
    return { visits: row?.visits ?? 0, productViews: row?.productViews ?? 0 };
  }
}
