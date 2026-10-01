import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import type { EscrowStatus, Permission, Settlement } from '../../common/domain';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { containsRegex } from '../../common/util/text';
import { formatNaira } from '../../common/util/money';
import { AuditService } from '../audit/audit.service';
import { Product } from '../products/schemas/product.schema';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/schemas/user.schema';
import { toEscrowTransaction, type EscrowTransactionView } from './order.presenter';
import { OrdersService, type Actor } from './orders.service';
import { Order } from './schemas/order.schema';

const SETTLEMENT_PERMISSION: Record<Settlement, Permission> = {
  released: 'escrow.release',
  refunded: 'escrow.release',
  'force-released': 'escrow.force',
  reversed: 'escrow.reverse',
};

const SETTLEMENT_ACTION: Record<Settlement, string> = {
  released: 'Approved release of escrow funds',
  refunded: 'Refunded escrow funds to the buyer',
  'force-released': 'Force-released held funds',
  reversed: 'Reversed an escrow decision',
};

/** Escrow & Payments Management: the ledger and the four verbs its row menus offer. */
@Injectable()
export class EscrowAdminService {
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    private readonly orderService: OrdersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private async views(rows: Lean<Order>[]): Promise<EscrowTransactionView[]> {
    const people = await this.users.find({ _id: { $in: rows.flatMap((row) => [row.buyerId, row.sellerId]) } }).lean<Lean<User>[]>();
    const byId = new Map(people.map((person) => [String(person._id), person]));
    const products = await this.products
      .find({ _id: { $in: rows.map((row) => row.items[0]?.productId).filter(Boolean) } })
      .select('categoryId')
      .lean<Lean<Product>[]>();
    const category = new Map(products.map((product) => [String(product._id), product.categoryId]));
    return rows.map((row) =>
      toEscrowTransaction(row, byId.get(String(row.buyerId)) ?? null, byId.get(String(row.sellerId)) ?? null, category.get(String(row.items[0]?.productId)) ?? null),
    );
  }

  async list(query: { search?: string; status?: EscrowStatus | 'all'; page?: number; limit?: number }): Promise<Page<EscrowTransactionView>> {
    const filter: Record<string, unknown> = { escrow: { $exists: true } };
    if (query.status && query.status !== 'all') filter['escrow.status'] = query.status;
    if (query.search?.trim()) {
      const pattern = containsRegex(query.search);
      const people = await this.users
        .find({ $or: [{ firstName: pattern }, { lastName: pattern }, { email: pattern }, { 'seller.storeName': pattern }] })
        .select('_id')
        .limit(300)
        .lean();
      const ids = people.map((person) => person._id);
      filter.$or = [{ 'escrow.reference': pattern }, { reference: pattern }, { 'items.title': pattern }, { buyerId: { $in: ids } }, { sellerId: { $in: ids } }];
    }
    const total = await this.orders.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 8);
    const rows = await this.orders.find(filter).sort({ 'escrow.fundedAt': -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<Order>[]>();
    return toPage(await this.views(rows), total, window);
  }

  async get(id: string): Promise<EscrowTransactionView> {
    const order = Types.ObjectId.isValid(id) ? await this.orders.findOne({ _id: id, escrow: { $exists: true } }).lean<Lean<Order>>() : null;
    if (!order) throw Errors.notFound('That transaction is no longer on the ledger.', 'TRANSACTION_NOT_FOUND');
    return (await this.views([order]))[0];
  }

  /**
   * Every verb moves money in the real world, so each is checked against
   * the role matrix, the escrow master switch and the current phase, then
   * audited. Force-release and reversal are the superadmin-only pair.
   */
  async settle(staff: AuthStaff, id: string, settlement: Settlement, note?: string): Promise<{ id: string; status: EscrowStatus; settlement: Settlement; transaction: EscrowTransactionView }> {
    if (!(await this.settings.can(staff.role, SETTLEMENT_PERMISSION[settlement]))) {
      throw Errors.forbidden('Your role does not allow this action.', 'PERMISSION_DENIED');
    }
    const order = Types.ObjectId.isValid(id) ? await this.orders.findOne({ _id: id, escrow: { $exists: true } }).lean<Lean<Order>>() : null;
    if (!order?.escrow) throw Errors.notFound('That transaction is no longer on the ledger.', 'TRANSACTION_NOT_FOUND');
    const escrowEnabled = (await this.settings.section('escrow')).enabled;
    if (!escrowEnabled && (settlement === 'force-released' || settlement === 'reversed')) {
      throw Errors.conflict('Escrow is switched off, so funds cannot be force-released or reversed.', 'ESCROW_DISABLED');
    }

    const actor: Actor = { kind: 'staff', id: staff.id, name: `${staff.firstName} ${staff.lastName}` };
    const phase = order.escrow.phase;
    const wrongPhase = () =>
      Errors.conflict(`This transaction is ${phase} and cannot be ${settlement.replace('-', ' ')}.`, 'INVALID_SETTLEMENT', { phase });

    switch (settlement) {
      case 'released':
        if (!['funded', 'shipped', 'inspection'].includes(phase)) throw wrongPhase();
        await this.orderService.releaseEscrow(order, actor, 'released', note);
        break;
      case 'refunded':
        if (!['funded', 'shipped', 'inspection'].includes(phase)) throw wrongPhase();
        await this.orderService.refundEscrow(order, actor, note?.trim() || 'Refunded by DOOAA.', ['funded', 'shipped', 'inspection']);
        break;
      case 'force-released':
        if (phase !== 'disputed') throw wrongPhase();
        await this.orderService.releaseEscrow(order, actor, 'force-released', note);
        break;
      case 'reversed':
        if (phase !== 'released') throw wrongPhase();
        await this.orderService.reverseRelease(order, actor, note);
        break;
    }

    await this.audit.record(staff, {
      action: SETTLEMENT_ACTION[settlement],
      target: `${order.escrow.reference} (${formatNaira(order.total)})`,
      targetType: 'escrow',
      targetId: String(order._id),
      elevated: settlement === 'force-released' || settlement === 'reversed',
      meta: { from: phase, settlement, note },
    });
    const transaction = await this.get(id);
    return { id, status: transaction.status, settlement: transaction.settlement ?? settlement, transaction };
  }
}
