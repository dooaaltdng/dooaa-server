import type {
  BankVerificationMethod,
  MeetupStatus,
  NotificationPrefs,
  VerificationDocumentKind,
} from '../../common/domain';

/*
 * Value objects stored in jsonb columns: snapshots and append-only logs that
 * are always read whole with their row and never queried on their own.
 * Timestamps inside them are ISO 8601 strings, exactly as JSON stores them.
 */

export type { NotificationPrefs };

/** One tile on the landing rail ("Vehicles", "Electronics"…), which uses its own labels. */
export type HomeTile = { label: string; order: number; image?: string };

export type ProductVideo = { url: string; posterUrl?: string };

/** Where the order goes — the cart's Delivery Information panel, frozen onto the order. */
export type DeliveryInfo = {
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
};

/** placed, confirmed, shipped, delivered, released, cancelled, refunded, disputed, dispute-resolved, reversed… */
export type TimelineEntry = { code: string; label: string; description: string; at: string };

export type EscrowHistoryEntry = { action: string; by: string; at: string; note?: string };

/** The snapshot of the bank a payout was sent to. */
export type PayoutDestination = {
  accountId: string;
  bankName: string;
  accountName: string;
  last4: string;
  recipientCode: string;
};

/** The listing a thread is about, pinned at the top of the chat. */
export type ConversationSubject = { title: string; summary: string; image: string; price: number };

export type MessageMedia = { url: string; posterUrl?: string; name?: string; size?: number; format?: string };

export type MessageProduct = { productId?: string; title: string; price: number; image: string };

/** "Propose a Meetup": a place, a day and a time window. */
export type MessageMeetup = {
  venue: string;
  address: string;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
  photo?: string;
  status: MeetupStatus;
  respondedAt?: string;
};

/** The red dispute panel: who raised it and why. */
export type MessageDispute = { by: string; reason: string };

export type OfferCounter = { amount: number; note: string; at: string };

export type ReviewAspects = Partial<
  Record<'communication' | 'valueForMoney' | 'itemAsDescribed' | 'shippingSpeed' | 'professionalism' | 'responsiveness', number>
>;

export type ReviewResponse = { body: string; at: string };

export type VerificationDocument = { kind: VerificationDocumentKind; mediaId: string; uploadedAt: string };

export type VerificationBank = {
  method: BankVerificationMethod;
  bankName: string;
  bankCode: string;
  last4: string;
  accountName: string;
  payoutAccountId?: string;
};
