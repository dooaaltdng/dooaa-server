import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ACCOUNT_STATUSES,
  CHECKOUT_METHODS,
  CONDITIONS,
  COUPON_TYPES,
  DELIVERY_TYPES,
  DISPUTE_OUTCOMES,
  DISPUTE_PARTIES,
  DISPUTE_STATES,
  EARNING_STATUSES,
  ESCROW_PHASES,
  ESCROW_STATUSES,
  GENDERS,
  ID_TYPES,
  IDENTITY_STATUSES,
  LISTED_AS,
  LISTING_PAYMENT_METHODS,
  LISTING_STATUSES,
  MEDIA_KINDS,
  MEDIA_PURPOSES,
  MEDIA_VISIBILITIES,
  MESSAGE_KINDS,
  NOTIFICATION_TONES,
  OAUTH_PROVIDERS,
  OFFER_STATUSES,
  ORDER_ACTORS,
  ORDER_KINDS,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
  OTP_CHANNELS,
  OTP_PURPOSES,
  PAYMENT_STATUSES,
  PAYOUT_ACCOUNT_SOURCES,
  PAYOUT_STATUSES,
  PRICING_TYPES,
  REFUND_STATUSES,
  SENDER_ROLES,
  SETTLEMENTS,
  STAFF_ROLES,
  STAFF_STATUSES,
  STAT_SCOPES,
  SUBJECT_TYPES,
  SUPPORT_STATUSES,
  USER_ROLES,
  VERIFICATION_LEVELS,
  VERIFICATION_STATUSES,
} from '../../common/domain';

/* Postgres enums for the domain vocabulary in common/domain.ts. Adding a value is a migration. */

export const userRole = pgEnum('user_role', USER_ROLES);
export const identityStatus = pgEnum('identity_status', IDENTITY_STATUSES);
export const accountStatus = pgEnum('account_status', ACCOUNT_STATUSES);
export const verificationLevel = pgEnum('verification_level', VERIFICATION_LEVELS);
export const gender = pgEnum('gender', GENDERS);
export const oauthProvider = pgEnum('oauth_provider', OAUTH_PROVIDERS);
export const subjectType = pgEnum('subject_type', SUBJECT_TYPES);
export const staffRole = pgEnum('staff_role', STAFF_ROLES);
export const staffStatus = pgEnum('staff_status', STAFF_STATUSES);
export const otpPurpose = pgEnum('otp_purpose', OTP_PURPOSES);
export const otpChannel = pgEnum('otp_channel', OTP_CHANNELS);

export const mediaPurpose = pgEnum('media_purpose', MEDIA_PURPOSES);
export const mediaKind = pgEnum('media_kind', MEDIA_KINDS);
export const mediaVisibility = pgEnum('media_visibility', MEDIA_VISIBILITIES);

export const productCondition = pgEnum('product_condition', CONDITIONS);
export const pricingType = pgEnum('pricing_type', PRICING_TYPES);
export const listingPaymentMethod = pgEnum('listing_payment_method', LISTING_PAYMENT_METHODS);
export const deliveryType = pgEnum('delivery_type', DELIVERY_TYPES);
export const listingStatus = pgEnum('listing_status', LISTING_STATUSES);
export const listedAs = pgEnum('listed_as', LISTED_AS);
export const couponType = pgEnum('coupon_type', COUPON_TYPES);

export const orderStatus = pgEnum('order_status', ORDER_STATUSES);
export const orderKind = pgEnum('order_kind', ORDER_KINDS);
export const orderActor = pgEnum('order_actor', ORDER_ACTORS);
export const orderPaymentStatus = pgEnum('order_payment_status', ORDER_PAYMENT_STATUSES);
export const checkoutMethod = pgEnum('checkout_method', CHECKOUT_METHODS);
export const escrowPhase = pgEnum('escrow_phase', ESCROW_PHASES);
export const escrowStatus = pgEnum('escrow_status', ESCROW_STATUSES);
export const settlement = pgEnum('settlement', SETTLEMENTS);
export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
export const refundStatus = pgEnum('refund_status', REFUND_STATUSES);
export const earningStatus = pgEnum('earning_status', EARNING_STATUSES);
export const payoutStatus = pgEnum('payout_status', PAYOUT_STATUSES);
export const payoutAccountSource = pgEnum('payout_account_source', PAYOUT_ACCOUNT_SOURCES);

export const messageKind = pgEnum('message_kind', MESSAGE_KINDS);
export const senderRole = pgEnum('sender_role', SENDER_ROLES);
export const offerStatus = pgEnum('offer_status', OFFER_STATUSES);
export const notificationTone = pgEnum('notification_tone', NOTIFICATION_TONES);
export const verificationStatus = pgEnum('verification_status', VERIFICATION_STATUSES);
export const idType = pgEnum('id_type', ID_TYPES);
export const disputeState = pgEnum('dispute_state', DISPUTE_STATES);
export const disputeOutcome = pgEnum('dispute_outcome', DISPUTE_OUTCOMES);
export const disputeParty = pgEnum('dispute_party', DISPUTE_PARTIES);
export const supportStatus = pgEnum('support_status', SUPPORT_STATUSES);
export const statScope = pgEnum('stat_scope', STAT_SCOPES);
