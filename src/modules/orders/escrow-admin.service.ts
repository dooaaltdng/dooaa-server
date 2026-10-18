import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, exists, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import type { EscrowStatus, Permission, Settlement } from '../../common/domain';
import { formatNaira } from '../../common/util/money';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { containsText, InjectDb, type Database } from '../../database/database';
import { orderItems, orders, products, users } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type { Order } from './order.model';
import { toEscrowTransaction, type EscrowTransactionView } from './order.presenter';
import { OrdersService, type Actor } from './orders.service';

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
    @InjectDb() private readonly db: Database,
    private readonly users: UsersService,
    private readonly orderService: OrdersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private async views(rows: Order[]): Promise<EscrowTransactionView[]> {
    const firstProducts = rows.map((row) => row.items[0]?.productId).filter((id): id is string => Boolean(id));
    const [people, categories] = await Promise.all([
      this.users.findByIds(rows.flatMap((row) => [row.buyerId, row.sellerId])),
      firstProducts.length ? this.db.select({ id: products.id, categoryId: products.categoryId }).from(products).where(inArray(products.id, firstProducts)) : [],
    ]);
    const byId = new Map(people.map((person) => [person.id, person]));
    const category = new Map(categories.map((product) => [product.id, product.categoryId]));
    return rows.map((row) =>
      toEscrowTransaction(row, byId.get(row.buyerId) ?? null, byId.get(row.sellerId) ?? null, category.get(row.items[0]?.productId ?? '') ?? null),
    );
  }

  async list(query: { search?: string; status?: EscrowStatus | 'all'; page?: number; limit?: number }): Promise<Page<EscrowTransactionView>> {
    const conditions: SQL[] = [isNotNull(orders.escrowReference)];
    if (query.status && query.status !== 'all') conditions.push(eq(orders.escrowStatus, query.status));
    const search = query.search?.trim();
    if (search) {
      const people = this.db
        .select({ id: users.id })
        .from(users)
        .where(or(containsText(users.firstName, search), containsText(users.lastName, search), containsText(users.email, search), containsText(users.sellerStoreName, search)));
      conditions.push(
        or(
          containsText(orders.escrowReference, search),
          containsText(orders.reference, search),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(orderItems)
              .where(and(eq(orderItems.orderId, orders.id), containsText(orderItems.title, search))),
          ),
          inArray(orders.buyerId, people),
          inArray(orders.sellerId, people),
        )!,
      );
    }
    const where = and(...conditions);
    const [{ total }] = await this.db.select({ total: count() }).from(orders).where(where);
    const window = pageWindow(total, query.page, query.limit ?? 8);
    const rows = await this.db
      .select()
      .from(orders)
      .where(where)
      .orderBy(descNullsLast(orders.escrowFundedAt), desc(orders.id))
      .offset(window.skip)
      .limit(window.size);
    return toPage(await this.views(await this.orderService.withItems(rows)), total, window);
  }

  private async ledgerOrder(id: string): Promise<Order | null> {
    const order = isUuid(id) ? await this.orderService.findById(id) : null;
    return order?.escrow ? order : null;
  }

  async get(id: string): Promise<EscrowTransactionView> {
    const order = await this.ledgerOrder(id);
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
    const order = await this.ledgerOrder(id);
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
      targetId: order.id,
      elevated: settlement === 'force-released' || settlement === 'reversed',
      meta: { from: phase, settlement, note },
    });
    const transaction = await this.get(id);
    return { id, status: transaction.status, settlement: transaction.settlement ?? settlement, transaction };
  }
}
