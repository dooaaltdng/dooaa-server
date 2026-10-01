import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import type { AccountStatus, ModeratedStatus, OrderStatus } from '../../common/domain';
import { dayKey } from '../../common/util/dates';
import type { Lean } from '../../common/util/mongo';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { escapeRegex, excerpt, normalizeEmail } from '../../common/util/text';
import { AuditService } from '../audit/audit.service';
import { Message } from '../conversations/schemas/message.schema';
import { Dispute } from '../disputes/dispute.schema';
import { MailService } from '../mail/mail.service';
import { Order } from '../orders/schemas/order.schema';
import { ProductsService } from '../products/products.service';
import { Product } from '../products/schemas/product.schema';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/schemas/user.schema';
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
  identity: User['identity'];
};

export type BuyerRow = AccountRow & { totalPurchase: number };
export type SellerRow = AccountRow & {
  verification: User['verificationLevel'];
  activeListings: number;
  storeName: string | null;
  /** Null when the seller may list without a cap. */
  listingLimit: number | null;
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
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Dispute.name) private readonly disputes: Model<Dispute>,
    @InjectModel(Message.name) private readonly messages: Model<Message>,
    private readonly userService: UsersService,
    private readonly productService: ProductsService,
    private readonly verification: VerificationService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private filter(role: 'buyer' | 'seller', query: UserFilters): QueryFilter<User> {
    const and: Record<string, unknown>[] = [];
    and.push(role === 'seller' ? { role: 'seller' } : { role: { $ne: 'seller' } });
    and.push({ email: { $ne: OFFICIAL_STORE_EMAIL } });
    and.push(query.statuses?.length ? { status: { $in: query.statuses } } : { status: { $ne: 'closed' } });
    if (query.regions?.length) and.push({ region: { $in: query.regions } });
    const joined: Record<string, Date> = {};
    if (query.joinedFrom) joined.$gte = new Date(`${query.joinedFrom}T00:00:00+01:00`);
    if (query.joinedTo) joined.$lte = new Date(`${query.joinedTo}T23:59:59.999+01:00`);
    if (Object.keys(joined).length) and.push({ createdAt: joined });
    const countField = role === 'seller' ? 'stats.activeListings' : 'stats.purchases';
    const count: Record<string, number> = {};
    if (query.minCount !== undefined) count.$gte = query.minCount;
    if (query.maxCount !== undefined) count.$lte = query.maxCount;
    if (Object.keys(count).length) and.push({ [countField]: count });
    const term = query.search?.trim();
    if (term) {
      // Each word must match a name, the email or the store; phone numbers match on digits alone.
      const words = term.split(/\s+/).slice(0, 4);
      for (const word of words) {
        const pattern = new RegExp(escapeRegex(word), 'i');
        and.push({ $or: [{ firstName: pattern }, { lastName: pattern }, { email: pattern }, { 'seller.storeName': pattern }, ...(/^\+?[\d\s]{4,}$/.test(word) ? [{ phone: new RegExp(escapeRegex(word.replace(/\D/g, ''))) }] : [])] });
      }
    }
    return { $and: and } as QueryFilter<User>;
  }

  private base(user: Lean<User>): AccountRow {
    return {
      id: String(user._id),
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      phone: user.phone ?? '',
      joinedDate: dayKey(user.createdAt),
      lastLogin: user.lastLoginAt ? dayKey(user.lastLoginAt) : null,
      status: user.status,
      avatar: user.avatarUrl ?? null,
      region: user.region ?? null,
      identity: user.identity,
    };
  }

  private buyerRow(user: Lean<User>): BuyerRow {
    return { ...this.base(user), totalPurchase: user.stats?.purchases ?? 0 };
  }

  private sellerRow(user: Lean<User>): SellerRow {
    return {
      ...this.base(user),
      verification: user.verificationLevel,
      activeListings: user.stats?.activeListings ?? 0,
      storeName: user.seller?.storeName ?? null,
      listingLimit: user.seller?.listingLimit ?? null,
    };
  }

  async listBuyers(query: UserFilters): Promise<Page<BuyerRow>> {
    const filter = this.filter('buyer', query);
    const total = await this.users.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 7);
    const rows = await this.users.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<User>[]>();
    return toPage(rows.map((row) => this.buyerRow(row)), total, window);
  }

  async listSellers(query: UserFilters): Promise<Page<SellerRow>> {
    const filter = this.filter('seller', query);
    const total = await this.users.countDocuments(filter);
    const window = pageWindow(total, query.page, query.limit ?? 7);
    const rows = await this.users.find(filter).sort({ createdAt: -1, _id: -1 }).skip(window.skip).limit(window.size).lean<Lean<User>[]>();
    return toPage(rows.map((row) => this.sellerRow(row)), total, window);
  }

  private async account(id: string, role: 'buyer' | 'seller'): Promise<Lean<User>> {
    const user = Types.ObjectId.isValid(id) ? await this.users.findById(id).lean<Lean<User>>() : null;
    const matches = user && (role === 'seller' ? user.role === 'seller' : user.role !== 'seller');
    if (!user || !matches) throw Errors.notFound(`That ${role} is not on the platform.`, 'USER_NOT_FOUND');
    return user;
  }

  private async disputesOf(userId: Types.ObjectId): Promise<{ disputes: ProfileDispute[]; messages: ProfileMessage[] }> {
    const rows = await this.disputes.find({ $or: [{ buyerId: userId }, { sellerId: userId }] }).sort({ createdAt: -1 }).limit(10).lean<Lean<Dispute>[]>();
    const disputes = rows.map((row) => ({
      id: String(row._id),
      reference: row.reference,
      subject: excerpt(row.reason, 60),
      orderId: row.orderNumber,
      status: row.state === 'completed' ? ('resolved' as const) : ('review' as const),
    }));
    const byConversation = new Map(rows.filter((row) => row.conversationId).map((row) => [String(row.conversationId), row.reference]));
    const authored = byConversation.size
      ? await this.messages
          .find({
            conversationId: { $in: [...byConversation.keys()].map((id) => new Types.ObjectId(id)) },
            senderId: userId,
            $or: [{ body: { $ne: '' } }, { kind: 'dispute' }],
          })
          .sort({ createdAt: -1 })
          .limit(5)
          .lean<Lean<Message>[]>()
      : [];
    const messages = authored.map((message) => ({
      id: String(message._id),
      reference: byConversation.get(String(message.conversationId)) ?? '',
      excerpt: excerpt(message.body || message.dispute?.reason || '', 90),
      date: dayKey(message.createdAt),
    }));
    return { disputes, messages };
  }

  async buyerProfile(id: string) {
    const user = await this.account(id, 'buyer');
    const orders = await this.orders.find({ buyerId: user._id, status: { $ne: 'awaiting-payment' } }).sort({ createdAt: -1 }).limit(5).lean<Lean<Order>[]>();
    const sellers = await this.users.find({ _id: { $in: orders.map((order) => order.sellerId) } }).select('email').lean();
    const sellerEmail = new Map(sellers.map((seller) => [String(seller._id), seller.email]));
    const verified = user.identity === 'verified';
    const kycHeadline = verified ? 'Level 2 Verified' : user.identity === 'pending' ? 'Level 1 — ID under review' : user.identity === 'rejected' ? 'Level 1 — ID rejected' : 'Level 1 — Awaiting ID';
    return {
      ...this.buyerRow(user),
      kycLevel: verified ? 2 : 1,
      kycHeadline,
      kycDetail: verified ? 'ID and Proof of selfie is confirmed' : user.emailVerified ? 'Email and phone confirmed. No ID on file.' : 'Email not yet confirmed.',
      transactions: orders.map((order) => ({
        id: String(order._id),
        orderId: `#${order.reference}`,
        item: order.items.length > 1 ? `${order.items[0].title} +${order.items.length - 1} more` : order.items[0].title,
        sellerEmail: sellerEmail.get(String(order.sellerId)) ?? '',
        date: dayKey(order.createdAt),
        status: TRANSACTION_STATUS[order.status] ?? order.status,
      })),
      ...(await this.disputesOf(user._id)),
    };
  }

  async sellerProfile(id: string) {
    const user = await this.account(id, 'seller');
    const [listings, listingCount, sold, soldCount, verification] = await Promise.all([
      this.products.find({ sellerId: user._id, deletedAt: null }).sort({ createdAt: -1 }).limit(4).lean<Lean<Product>[]>(),
      this.products.countDocuments({ sellerId: user._id, deletedAt: null }),
      this.orders.find({ sellerId: user._id, 'payment.status': 'paid' }).sort({ createdAt: -1 }).limit(4).lean<Lean<Order>[]>(),
      this.orders.countDocuments({ sellerId: user._id, 'payment.status': 'paid' }),
      this.verification.latestFor(String(user._id)),
    ]);
    const documents: KycDocumentView[] = verification ? await this.verification.documentsFor(verification) : [];
    return {
      ...this.sellerRow(user),
      verificationStatus: verification?.status ?? null,
      verificationId: verification ? String(verification._id) : null,
      documents,
      listings: listings.map((product) => ({ id: String(product._id), product: product.title, price: product.price, stock: product.stock, status: product.status, dateListed: dayKey(product.publishedAt ?? product.createdAt) })),
      listingCount,
      sold: sold.map((order) => ({ id: String(order._id), item: order.items[0]?.title ?? 'Order', orderId: `#${order.reference}`, salePrice: order.total, dateListed: dayKey(order.payment.paidAt ?? order.createdAt) })),
      soldCount,
      ...(await this.disputesOf(user._id)),
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
    const user = Types.ObjectId.isValid(id) ? await this.users.findById(id).lean<Lean<User>>() : null;
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
      await this.verification.approve(staff, String(pending._id));
      return { id, identity: 'verified' as const };
    }
    await this.userService.update(id, { $set: { identity: 'verified' } });
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
    await this.userService.update(id, { $set: { 'seller.listingLimit': limit } });
    await this.audit.record(staff, {
      action: limit === null ? "Lifted a seller's listing limit" : `Limited a seller to ${limit} live listing${limit === 1 ? '' : 's'}`,
      target: `${user.firstName} ${user.lastName}`,
      targetType: 'user',
      targetId: id,
      meta: { from: user.seller?.listingLimit ?? null, to: limit },
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
    const user = Types.ObjectId.isValid(id) ? await this.users.findById(id).lean<Lean<User>>() : null;
    if (!user || user.email === OFFICIAL_STORE_EMAIL) throw Errors.notFound('That account is not on the platform.', 'USER_NOT_FOUND');
    if (user.status === 'closed') throw Errors.conflict('This account was closed by its owner.', 'ACCOUNT_CLOSED');
    const next = normalizeEmail(email);
    if (next === user.email) return { id, email: next, emailVerified: user.emailVerified };
    const taken = await this.userService.findByEmail(next);
    if (taken) throw Errors.conflict('Another account already uses that email.', 'EMAIL_TAKEN');
    try {
      await this.userService.update(id, { $set: { email: next, emailVerified: false } });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw Errors.conflict('Another account already uses that email.', 'EMAIL_TAKEN');
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
}
