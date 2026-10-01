import type { Schema } from 'mongoose';
import { AuditEntrySchema } from '../modules/audit/audit.schema';
import { SessionSchema } from '../modules/auth/schemas/session.schema';
import { MediaSchema } from '../modules/media/media.schema';
import { OtpSchema } from '../modules/otp/otp.schema';
import { SettingsRecordSchema } from '../modules/settings/settings.schema';
import { StaffSchema } from '../modules/staff/schemas/staff.schema';
import { UserSchema } from '../modules/users/schemas/user.schema';
import { CategorySchema } from '../modules/categories/category.schema';
import { PaymentSchema } from '../modules/payments/schemas/payment.schema';
import { PayoutAccountSchema } from '../modules/payments/schemas/payout-account.schema';
import { SandboxRecordSchema } from '../modules/payments/schemas/sandbox-record.schema';
import { SavedCardSchema } from '../modules/payments/schemas/saved-card.schema';
import { ProductSchema } from '../modules/products/schemas/product.schema';
import { WishlistItemSchema } from '../modules/wishlist/wishlist.schema';
import { CartSchema } from '../modules/cart/cart.schema';
import { CouponSchema } from '../modules/coupons/coupon.schema';
import { OrderSchema } from '../modules/orders/schemas/order.schema';
import { OfferSchema } from '../modules/conversations/schemas/offer.schema';
import { EarningSchema, PayoutSchema, WalletSchema } from '../modules/wallet/wallet.schema';
import { ConversationSchema } from '../modules/conversations/schemas/conversation.schema';
import { MessageSchema } from '../modules/conversations/schemas/message.schema';
import { NotificationSchema } from '../modules/notifications/notification.schema';
import { ReviewSchema } from '../modules/reviews/review.schema';
import { VerificationSchema } from '../modules/verification/verification.schema';
import { DisputeSchema } from '../modules/disputes/dispute.schema';
import { ContentPageSchema, ContentVersionSchema } from '../modules/content/content.schema';
import { CounterSchema } from './counter.schema';
import { DailyStatSchema, VisitorDaySchema } from '../modules/analytics/analytics.schema';
import { SupportTicketSchema } from '../modules/support/support.schema';

/** Every collection schema, for structural checks (see schemas.spec.ts). */
export const ALL_SCHEMAS: Record<string, Schema> = {
  AuditEntry: AuditEntrySchema,
  Session: SessionSchema,
  Media: MediaSchema,
  Otp: OtpSchema,
  SettingsRecord: SettingsRecordSchema,
  Staff: StaffSchema,
  User: UserSchema,
  Category: CategorySchema,
  Payment: PaymentSchema,
  PayoutAccount: PayoutAccountSchema,
  SandboxRecord: SandboxRecordSchema,
  SavedCard: SavedCardSchema,
  Product: ProductSchema,
  WishlistItem: WishlistItemSchema,
  Cart: CartSchema,
  Coupon: CouponSchema,
  Order: OrderSchema,
  Offer: OfferSchema,
  Wallet: WalletSchema,
  Earning: EarningSchema,
  Payout: PayoutSchema,
  Conversation: ConversationSchema,
  Message: MessageSchema,
  Notification: NotificationSchema,
  Review: ReviewSchema,
  Verification: VerificationSchema,
  Dispute: DisputeSchema,
  ContentPage: ContentPageSchema,
  ContentVersion: ContentVersionSchema,
  Counter: CounterSchema,
  DailyStat: DailyStatSchema,
  VisitorDay: VisitorDaySchema,
  SupportTicket: SupportTicketSchema,
};
