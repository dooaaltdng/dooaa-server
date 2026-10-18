import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import type { AccountStatus, IdentityStatus, ModeratedStatus, OrderStatus, VerificationLevel } from '../../common/domain';
import { dayKey } from '../../common/util/dates';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { excerpt, normalizeEmail } from '../../common/util/text';
import { escapeRegex, InjectDb, isUniqueViolation, type Database } from '../../database/database';
import { and, contains, eq, gte, inArray, isNotNull, isNull, lte, ne, or, type Condition } from '../../database/query';
import { disputes, messages, orderItems, orders, products, users } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import type { Order } from '../orders/order.model';
import { OrdersService } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';
import { toUser, userOmit, type User } from '../users/user.model';
import { UsersService } from '../users/users.service';
import { VerificationService, type KycDocumentView } from '../verification/verification.service';

export type UserFilters = {
  search?: string;
  page?: number;
  limit?: number;
  joinedFrom?: string;
  joinedTo?: string;
  minCount?: number;
  maxCount?: number;
  regions?: string[];
  statuses?: AccountStatus[];
};

type AccountRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  joinedDate: string;
  lastLogin: string | null;
  status: AccountStatus;
  avatar: string | null;
  region: string | null;
  identity: IdentityStatus;
};

export type BuyerRow = AccountRow & { totalPurchase: number };
export type SellerRow = AccountRow & {
  verification: VerificationLevel;
  activeListings: number;
  storeName: string | null;
  /** Null when the seller may list without a cap. */
  listingLimit: number | null;
};

export type ConsoleSearchResults = {
  users: { id: string; name: string; email: string; role: 'buyer' | 'seller'; status: AccountStatus; href: string }[];
  listings: { id: string; title: string; sellerName: string; status: string; href: string }[];
  transactions: { id: string; reference: string; orderNumber: string; item: string; amount: number; href: string }[];
  disputes: { id: string; reference: string; item: string; state: string; href: string }[];
};

type ProfileDispute = { id: string; reference: string; subject: string; orderId: string; status: 'review' | 'resolved' };
type ProfileMessage = { id: string; reference: string; excerpt: string; date: string };

const OFFICIAL_STORE_EMAIL = 'store@dooaa.ng';
const TRANSACTION_STATUS: Partial<Record<OrderStatus, string>> = {
  pending: 'pending',
  confirmed: 'confirmed',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

const STATUS_ACTION: Record<ModeratedStatus, string> = {
  active: 'Restored an account',
  review: 'Put an account under review',
  suspended: 'Suspended an account',
  banned: 'Banned an account',
};

/** User Management: the buyer and seller tables, profiles and account actions. */
@Injectable()
export class AdminUsersService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly orderService: OrdersService,
    private readonly userService: UsersService,
    private readonly productService: ProductsService,
    private readonly verification: VerificationService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private filter(role: 'buyer' | 'seller', query: UserFilters): Condition {
    const conditions: Condition[] = [
      // Accounts that have not picked a role yet sit with the buyers.
      role === 'seller' ? eq(users.role, 'seller') : ne(users.role, 'seller'),
      ne(users.email, OFFICIAL_STORE_EMAIL),
      query.statuses?.length ? inArray(users.status, query.statuses) : ne(users.status, 'closed'),
    ];
    if (query.regions?.length) conditions.push(inArray(users.region, query.regions));
    if (query.joinedFrom) conditions.push(gte(users.createdAt, new Date(`${query.joinedFrom}T00:00:00+01:00`)));
    if (query.joinedTo) conditions.push(lte(users.createdAt, new Date(`${query.joinedTo}T23:59:59.999+01:00`)));
    const countColumn = role === 'seller' ? users.statsActiveListings : users.statsPurchases;
    if (query.minCount !== undefined) conditions.push(gte(countColumn, query.minCount));
    if (query.maxCount !== undefined) conditions.push(lte(countColumn, query.maxCount));
    const term = query.search?.trim();
    if (term) {
      // Each word must match a name, the email or the store; phone numbers match on digits alone.
      for (const word of term.split(/\s+/).slice(0, 4)) {
        const matches = [contains(users.firstName, word), contains(users.lastName, word), contains(users.email, word), contains(users.sellerStoreName, word)];
        if (/^\+?[\d\s]{4,}$/.test(word)) matches.push(contains(users.phone, word.replace(/\D/g, '')));
        conditions.push(or(...matches));
      }
    }
    return and(...conditions);
  }

  private base(user: User): AccountRow {
    return {
      id: user.id,
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      phone: user.phone,
      joinedDate: dayKey(user.createdAt),
      lastLogin: user.lastLoginAt ? dayKey(user.lastLoginAt) : null,
      status: user.status,
      avatar: user.avatarUrl,
      region: user.region,
      identity: user.identity,
    };
  }

  private buyerRow(user: User): BuyerRow {
    return { ...this.base(user), totalPurchase: user.stats.purchases };
  }

  private sellerRow(user: User): SellerRow {
    return {
      ...this.base(user),
      verification: user.verificationLevel,
      activeListings: user.stats.activeListings,
      storeName: user.seller.storeName,
      listingLimit: user.seller.listingLimit,
    };
  }

  private async page(where: Condition, query: UserFilters): Promise<{ rows: User[]; total: number; window: ReturnType<typeof pageWindow> }> {
    const total = await this.db.count(users, where);
    const window = pageWindow(total, query.page, query.limit ?? 7);
    const rows = await this.db.find(users, where, { sort: { createdAt: -1, id: -1 }, skip: window.skip, limit: window.size, omit: userOmit });
    return { rows: rows.map(toUser), total, window };
  }

  async listBuyers(query: UserFilters): Promise<Page<BuyerRow>> {
    const { rows, total, window } = await this.page(this.filter('buyer', query), query);
    return toPage(
      rows.map((row) => this.buyerRow(row)),
      total,
      window,
    );
  }

  async listSellers(query: UserFilters): Promise<Page<SellerRow>> {
    const { rows, total, window } = await this.page(this.filter('seller', query), query);
    return toPage(
      rows.map((row) => this.sellerRow(row)),
      total,
      window,
    );
  }

  private async account(id: string, role: 'buyer' | 'seller'): Promise<User> {
    const user = await this.userService.findById(id);
    const matches = user && (role === 'seller' ? user.role === 'seller' : user.role !== 'seller');
    if (!user || !matches) throw Errors.notFound(`That ${role} is not on the platform.`, 'USER_NOT_FOUND');
    return user;
  }

  private async disputesOf(userId: string): Promise<{ disputes: ProfileDispute[]; messages: ProfileMessage[] }> {
    const rows = await this.db.find(disputes, or(eq(disputes.buyerId, userId), eq(disputes.sellerId, userId)), { sort: { createdAt: -1 }, limit: 10 });
    const profileDisputes = rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      subject: excerpt(row.reason, 60),
      orderId: row.orderNumber,
      status: row.state === 'completed' ? ('resolved' as const) : ('review' as const),
    }));
    const byConversation = new Map(rows.filter((row) => row.conversationId).map((row) => [row.conversationId!, row.reference]));
    const authored = byConversation.size
      ? await this.db.find(
          messages,
          and(inArray(messages.conversationId, [...byConversation.keys()]), eq(messages.senderId, userId), or(ne(messages.body, ''), eq(messages.kind, 'dispute'))),
          { sort: { createdAt: -1 }, limit: 5 },
        )
      : [];
    const profileMessages = authored.map((message) => ({
      id: message.id,
      reference: byConversation.get(message.conversationId) ?? '',
      excerpt: excerpt(message.body || message.dispute?.reason || '', 90),
      date: dayKey(message.createdAt),
    }));
    return { disputes: profileDisputes, messages: profileMessages };
  }

  private async recentOrders(where: Condition, limit: number): Promise<Order[]> {
    return this.orderService.withItems(await this.db.find(orders, where, { sort: { createdAt: -1 }, limit }));
  }

  async buyerProfile(id: string) {
    const user = await this.account(id, 'buyer');
    const recent = await this.recentOrders(and(eq(orders.buyerId, user.id), ne(orders.status, 'awaiting-payment')), 5);
    const sellers = await this.userService.findByIds(recent.map((order) => order.sellerId));
    const sellerEmail = new Map(sellers.map((seller) => [seller.id, seller.email]));
    const verified = user.identity === 'verified';
    const kycHeadline = verified ? 'Level 2 Verified' : user.identity === 'pending' ? 'Level 1 — ID under review' : user.identity === 'rejected' ? 'Level 1 — ID rejected' : 'Level 1 — Awaiting ID';
    return {
      ...this.buyerRow(user),
      kycLevel: verified ? 2 : 1,
      kycHeadline,
      kycDetail: verified ? 'ID and Proof of selfie is confirmed' : user.emailVerified ? 'Email and phone confirmed. No ID on file.' : 'Email not yet confirmed.',
      transactions: recent.map((order) => ({
        id: order.id,
        orderId: `#${order.reference}`,
        item: order.items.length > 1 ? `${order.items[0].title} +${order.items.length - 1} more` : (order.items[0]?.title ?? 'Order'),
        sellerEmail: sellerEmail.get(order.sellerId) ?? '',
        date: dayKey(order.createdAt),
        status: TRANSACTION_STATUS[order.status] ?? order.status,
      })),
      ...(await this.disputesOf(user.id)),
    };
  }

  async sellerProfile(id: string) {
    const user = await this.account(id, 'seller');
    const listed = and(eq(products.sellerId, user.id), isNull(products.deletedAt));
    const paidSales = and(eq(orders.sellerId, user.id), eq(orders.paymentStatus, 'paid'));
    const [listings, listingCount, sold, soldCount, verification] = await Promise.all([
      this.db.find(products, listed, { sort: { createdAt: -1 }, limit: 4 }),
      this.db.count(products, listed),
      this.recentOrders(paidSales, 4),
      this.db.count(orders, paidSales),
      this.verification.latestFor(user.id),
    ]);
    const documents: KycDocumentView[] = verification ? await this.verification.documentsFor(verification) : [];
    return {
      ...this.sellerRow(user),
      verificationStatus: verification?.status ?? null,
      verificationId: verification?.id ?? null,
      documents,
      listings: listings.map((product) => ({ id: product.id, product: product.title, price: product.price, stock: product.stock, status: product.status, dateListed: dayKey(product.publishedAt ?? product.createdAt) })),
      listingCount,
      sold: sold.map((order) => ({ id: order.id, item: order.items[0]?.title ?? 'Order', orderId: `#${order.reference}`, salePrice: order.total, dateListed: dayKey(order.payment.paidAt ?? order.createdAt) })),
      soldCount,
      ...(await this.disputesOf(user.id)),
    };
  }

  /**
   * The row menu's account actions. Bans need `users.ban`; everything else
   * `users.suspend`. A restricted seller's listings leave the storefront and
   * come back when the account is restored.
   */
  async setStatus(staff: AuthStaff, id: string, status: ModeratedStatus, reason?: string) {
    const needed = status === 'banned' ? 'users.ban' : 'users.suspend';
    if (!(await this.settings.can(staff.role, needed))) throw Errors.forbidden('Your role does not allow this action.', 'PERMISSION_DENIED');
    const user = await this.userService.findById(id);
    if (!user || user.email === OFFICIAL_STORE_EMAIL) throw Errors.notFound('That account is not on the platform.', 'USER_NOT_FOUND');
    if (user.status === 'closed') throw Errors.conflict('This account was closed by its owner.', 'ACCOUNT_CLOSED');
    if (user.status === status) return { id, status };

    await this.userService.setStatus(id, status, reason);
    if (user.role === 'seller') {
      if (status === 'banned' || status === 'suspended') await this.productService.restrictSeller(id);
      if (status === 'active' || status === 'review') await this.productService.unrestrictSeller(id);
    }
    await this.audit.record(staff, {
      action: STATUS_ACTION[status],
      target: `${user.firstName} ${user.lastName}`,
      targetType: 'user',
      targetId: id,
      meta: { from: user.status, to: status, reason },
    });
    const copy: Record<ModeratedStatus, { subject: string; lines: string[] }> = {
      active: { subject: 'Your DOOAA account is active again', lines: ['Your account has been restored and you can use DOOAA as normal.'] },
      review: { subject: 'Your DOOAA account is under review', lines: ['Our team is reviewing recent activity on your account. You can keep using DOOAA while we do.'] },
      suspended: { subject: 'Your DOOAA account has been suspended', lines: ['Your account has been suspended and your listings are hidden for now.', 'Contact support if you would like to discuss this.'] },
      banned: { subject: 'Your DOOAA account has been banned', lines: ['Your account has been banned for breaking our Terms & Conditions.', 'Contact support if you believe this is a mistake.'] },
    };
    void this.mail.send(user.email, {
      subject: copy[status].subject,
      heading: copy[status].subject,
      paragraphs: [`Hi ${user.firstName},`, ...copy[status].lines, ...(reason ? [`Reason: ${reason}`] : [])],
    });
    return { id, status };
  }

  /**
   * "Verify seller manually": staff confirmed the seller's identity outside
   * the in-app flow. A submission waiting in the queue is approved with it, so
   * the queue and the account never disagree.
   */
  async verifyManually(staff: AuthStaff, id: string) {
    if (!(await this.settings.can(staff.role, 'users.verify'))) throw Errors.forbidden('Your role does not allow this action.', 'PERMISSION_DENIED');
    const user = await this.account(id, 'seller');
    if (user.identity === 'verified') return { id, identity: 'verified' as const };
    const pending = await this.verification.latestFor(id, 'pending');
    if (pending) {
      await this.verification.approve(staff, pending.id);
      return { id, identity: 'verified' as const };
    }
    await this.userService.update(id, { identity: 'verified' });
    await this.productService.syncSellerVerified(id, true);
    await this.audit.record(staff, { action: 'Verified a seller manually', target: `${user.firstName} ${user.lastName}`, targetType: 'user', targetId: id });
    void this.mail.send(user.email, {
      subject: 'Your DOOAA identity is verified',
      heading: 'You are verified',
      paragraphs: [`Great news, ${user.firstName} — our team has confirmed your identity.`, 'Buyers now see the verified badge on your listings and in chat.'],
    });
    return { id, identity: 'verified' as const };
  }

  /** "Limit seller listing": caps how many listings can be live or in review at once (null lifts it). */
  async setListingLimit(staff: AuthStaff, id: string, limit: number | null) {
    if (!(await this.settings.can(staff.role, 'users.suspend'))) throw Errors.forbidden('Your role does not allow this action.', 'PERMISSION_DENIED');
    const user = await this.account(id, 'seller');
    await this.userService.update(id, { sellerListingLimit: limit });
    await this.audit.record(staff, {
      action: limit === null ? "Lifted a seller's listing limit" : `Limited a seller to ${limit} live listing${limit === 1 ? '' : 's'}`,
      target: `${user.firstName} ${user.lastName}`,
      targetType: 'user',
      targetId: id,
      meta: { from: user.seller.listingLimit, to: limit },
    });
    void this.mail.send(user.email, {
      subject: limit === null ? 'Your DOOAA listing limit has been lifted' : 'A listing limit has been set on your DOOAA store',
      heading: limit === null ? 'Listing limit lifted' : 'Listing limit set',
      paragraphs:
        limit === null
          ? [`Hi ${user.firstName},`, 'You can publish as many listings as you like again.']
          : [`Hi ${user.firstName},`, `Your store can now have up to ${limit} listing${limit === 1 ? '' : 's'} live or in review at a time. Listings already live stay up.`, 'Contact support if you would like to discuss this.'],
    });
    return { id, listingLimit: limit };
  }

  /**
   * "Change buyer/seller email" — support moving an account to a new address.
   * The new address has to be confirmed again; both addresses are told.
   */
  async changeEmail(staff: AuthStaff, id: string, email: string) {
    if (!(await this.settings.can(staff.role, 'users.verify'))) throw Errors.forbidden('Your role does not allow this action.', 'PERMISSION_DENIED');
    const user = await this.userService.findById(id);
    if (!user || user.email === OFFICIAL_STORE_EMAIL) throw Errors.notFound('That account is not on the platform.', 'USER_NOT_FOUND');
    if (user.status === 'closed') throw Errors.conflict('This account was closed by its owner.', 'ACCOUNT_CLOSED');
    const next = normalizeEmail(email);
    if (next === user.email) return { id, email: next, emailVerified: user.emailVerified };
    const taken = await this.userService.findByEmail(next);
    if (taken) throw Errors.conflict('Another account already uses that email.', 'EMAIL_TAKEN');
    try {
      await this.userService.update(id, { email: next, emailVerified: false });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) throw Errors.conflict('Another account already uses that email.', 'EMAIL_TAKEN');
      throw error;
    }
    await this.audit.record(staff, {
      action: 'Changed an account email',
      target: `${user.firstName} ${user.lastName}`,
      targetType: 'user',
      targetId: id,
      meta: { from: user.email, to: next },
    });
    void this.mail.send(user.email, {
      subject: 'Your DOOAA email address was changed',
      heading: 'Your email address was changed',
      paragraphs: [`Hi ${user.firstName},`, `At your request, DOOAA support changed the email on your account to ${next}.`, 'If you did not ask for this, contact support immediately.'],
    });
    void this.mail.send(next, {
      subject: 'Confirm your new DOOAA email address',
      heading: 'Confirm your email address',
      paragraphs: [`Hi ${user.firstName},`, 'Your DOOAA account now uses this email address. Sign in and confirm it from your account settings to keep receiving order updates.'],
    });
    return { id, email: next, emailVerified: false };
  }

  /**
   * The topbar search: one box across accounts, listings, escrow
   * transactions and disputes. Each group is capped, and every hit carries
   * the console route that opens it.
   */
  async search(raw: string): Promise<ConsoleSearchResults> {
    const term = raw.trim().slice(0, 80);
    const empty: ConsoleSearchResults = { users: [], listings: [], transactions: [], disputes: [] };
    if (term.length < 2) return empty;
    const bare = escapeRegex(term.replace(/^#/, ''));
    // References match from the start, with or without the leading "#".
    const startsRef = (field: string): Condition => ({ [field]: { $regex: `^#?${bare}`, $options: 'i' } });
    const itemOrders = await this.db.distinct(orderItems, 'orderId', contains(orderItems.title, term));
    const digits = term.replace(/\D/g, '');
    const words = term.split(/\s+/).slice(0, 3);

    const [userRows, listings, orderRows, disputeRows] = await Promise.all([
      this.db.find(
        users,
          and(
            ne(users.email, OFFICIAL_STORE_EMAIL),
            or(
              contains(users.firstName, term),
              contains(users.lastName, term),
              contains(users.email, term),
              contains(users.sellerStoreName, term),
              term.includes(' ') ? and(...words.map((word) => or(contains(users.firstName, word), contains(users.lastName, word)))) : undefined,
              digits.length >= 4 ? contains(users.phone, digits) : undefined,
            ),
          ),
        { sort: { createdAt: -1 }, limit: 5, omit: userOmit },
      ),
      this.db.find(products, and(isNull(products.deletedAt), contains(products.title, term)), { sort: { createdAt: -1 }, limit: 5 }),
      this.db
        .find(orders, and(isNotNull(orders.escrowReference), or(startsRef('escrowReference'), startsRef('reference'), inArray(orders.id, itemOrders))), {
          sort: { createdAt: -1 },
          limit: 5,
        })
        .then((rows) => this.orderService.withItems(rows)),
      this.db.find(disputes, or(startsRef('reference'), startsRef('orderNumber'), contains(disputes.item, term)), { sort: { createdAt: -1 }, limit: 5 }),
    ]);

    const sellers = await this.userService.findByIds(listings.map((product) => product.sellerId));
    const sellerName = new Map(sellers.map((seller) => [seller.id, seller.seller.storeName || `${seller.firstName} ${seller.lastName}`]));

    return {
      users: userRows.map(toUser).map((user) => {
        const role = user.role === 'seller' ? 'seller' : 'buyer';
        return {
          id: user.id,
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: user.email,
          role,
          status: user.status,
          href: `/users/${role === 'seller' ? 'sellers' : 'buyers'}/${user.id}`,
        };
      }),
      listings: listings.map((product) => ({
        id: product.id,
        title: product.title,
        sellerName: sellerName.get(product.sellerId) ?? 'Seller',
        status: product.status,
        href: `/listings?item=${product.id}`,
      })),
      transactions: orderRows.map((order) => ({
        id: order.id,
        reference: order.escrow!.reference,
        orderNumber: `#${order.reference}`,
        item: order.items.length > 1 ? `${order.items[0].title} +${order.items.length - 1} more` : (order.items[0]?.title ?? 'Order'),
        amount: order.total,
        href: `/payments?search=${encodeURIComponent(order.escrow!.reference)}`,
      })),
      disputes: disputeRows.map((dispute) => ({
        id: dispute.id,
        reference: dispute.reference,
        item: dispute.item,
        state: dispute.state,
        href: `/disputes?id=${dispute.id}`,
      })),
    };
  }
}
