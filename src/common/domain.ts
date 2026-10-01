/**
 * The marketplace vocabulary, shared by every module. Values are the API's
 * canonical (kebab/lower-case) forms; labels mirror the copy the apps draw.
 */

/* --- Accounts ------------------------------------------------------------ */

export const USER_ROLES = ['buyer', 'seller'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Identity (KYC) verification from the /verification wizard. */
export const IDENTITY_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** The four lifecycle states the console colours, plus a self-closed account. */
export const ACCOUNT_STATUSES = ['active', 'review', 'suspended', 'banned', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
/** The statuses staff can set from the console. */
export const MODERATED_STATUSES = ['active', 'review', 'suspended', 'banned'] as const;
export type ModeratedStatus = (typeof MODERATED_STATUSES)[number];

/** Sellers only. "High-Value" sellers clear a stricter KYC bar. */
export const VERIFICATION_LEVELS = ['normal', 'high-value'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const GENDERS = ['male', 'female', 'prefer-not-to-say'] as const;
export type Gender = (typeof GENDERS)[number];

/** Cities offered on the profile form, and the state each rolls up to for the console's region facet. */
export const LOCATION_REGION: Record<string, string> = {
  Lagos: 'Lagos',
  Abuja: 'Abuja (FCT)',
  'Port Harcourt': 'Rivers',
  Ibadan: 'Oyo',
  Kano: 'Kano',
  Enugu: 'Enugu',
};

export const DEFAULT_REGIONS = ['Lagos', 'Abuja (FCT)', 'Rivers', 'Kano', 'Oyo', 'Enugu'];

export function regionFor(location?: string | null): string | undefined {
  if (!location) return undefined;
  const direct = LOCATION_REGION[location.trim()];
  if (direct) return direct;
  const match = Object.keys(LOCATION_REGION).find((city) => location.toLowerCase().includes(city.toLowerCase()));
  return match ? LOCATION_REGION[match] : location.trim();
}

export const NOTIFICATION_PREF_KEYS = ['email', 'deals', 'sms', 'messages', 'feedback', 'web'] as const;
export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];
export type NotificationPrefs = Record<NotificationPrefKey, boolean>;
/** Defaults as drawn on the settings panel. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  email: true,
  deals: true,
  sms: false,
  messages: true,
  feedback: false,
  web: true,
};

/** Exit survey on the close-account panel, in the order drawn. */
export const CLOSE_REASONS = [
  "I don't recall creating an account",
  "It's hard to understand the pricing or fees",
  "The app doesn't meet my buying or selling needs",
  "I'm not currently buying or selling anything",
  'The app feels complicated to use',
  "It's too expensive to sell here",
  'Other reason (please tell us)',
] as const;

/* --- Staff & permissions ------------------------------------------------- */

export const STAFF_ROLES = ['superadmin', 'admin', 'moderator'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  moderator: 'Moderator',
};

export const PERMISSIONS = [
  'users.suspend',
  'users.ban',
  'users.verify',
  'listings.moderate',
  'listings.delete',
  'disputes.rule',
  'escrow.release',
  'escrow.force',
  'escrow.reverse',
  'content.publish',
  'settings.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Locked to superadmin: a role that could grant itself these would make the tier meaningless. */
export const SUPERADMIN_ONLY: Permission[] = ['escrow.force', 'escrow.reverse'];

export type RolePermissions = Record<StaffRole, Permission[]>;

export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  superadmin: [...PERMISSIONS],
  admin: [
    'users.suspend',
    'users.ban',
    'users.verify',
    'listings.moderate',
    'listings.delete',
    'disputes.rule',
    'escrow.release',
    'content.publish',
  ],
  moderator: ['users.suspend', 'listings.moderate', 'disputes.rule'],
};

/* --- Catalog ------------------------------------------------------------- */

export const CONDITIONS = ['new', 'slightly-used', 'used', 'refurbished'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<Condition, string> = {
  new: 'Brand New',
  'slightly-used': 'Slightly Used',
  used: 'Used',
  refurbished: 'Refurbished',
};

export const PRICING_TYPES = ['fixed', 'negotiable'] as const;
export type PricingType = (typeof PRICING_TYPES)[number];

/** How a listing is paid for — "DOOAA - Escrow Services" or "DOOAA - Default Method". */
export const LISTING_PAYMENT_METHODS = ['escrow', 'default'] as const;
export type ListingPaymentMethod = (typeof LISTING_PAYMENT_METHODS)[number];

export const DELIVERY_TYPES = ['meetup', 'local', 'nationwide', 'digital'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];
export const DELIVERY_LABEL: Record<DeliveryType, string> = {
  meetup: 'Meetup only',
  local: 'Local delivery',
  nationwide: 'Nationwide delivery',
  digital: 'Digital delivery',
};

/**
 * Listing lifecycle. "Out of stock" is not a status: it is an active listing
 * with no stock, reported as `stockStatus`.
 */
export const LISTING_STATUSES = ['draft', 'pending', 'active', 'inactive', 'suspicious', 'rejected'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Who the listing is published under — the console's "Mark listings as" radios. */
export const LISTED_AS = ['seller', 'official', 'admin'] as const;
export type ListedAs = (typeof LISTED_AS)[number];

export const COLLECTIONS = ['top-sellers', 'featured', 'popular'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export const SORT_KEYS = ['relevance', 'newest', 'price-asc', 'price-desc'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const PRICE_BANDS = {
  any: { min: 0, max: Infinity },
  'under-300k': { min: 0, max: 300_000 },
  '300k-500k': { min: 300_000, max: 500_000 },
  'over-500k': { min: 500_000, max: Infinity },
} as const;
export type PriceBand = keyof typeof PRICE_BANDS;

/* --- Orders, escrow, money ------------------------------------------------ */

export const ORDER_STATUSES = ['awaiting-payment', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** "One time" (cart checkout) or "Escrow payment" (Buy via Escrow). */
export const ORDER_KINDS = ['standard', 'escrow'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** How the buyer pays on the provider's checkout. */
export const CHECKOUT_METHODS = ['card', 'transfer', 'ussd', 'bank'] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

/** Where the buyer's money is, as the thread and the console see it. */
export const ESCROW_PHASES = ['funded', 'shipped', 'inspection', 'disputed', 'released', 'refunded'] as const;
export type EscrowPhase = (typeof ESCROW_PHASES)[number];

/** The ledger's three-way status in the console. */
export const ESCROW_STATUSES = ['pending', 'dispute', 'completed'] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export function escrowStatusOf(phase: EscrowPhase): EscrowStatus {
  if (phase === 'disputed') return 'dispute';
  if (phase === 'released' || phase === 'refunded') return 'completed';
  return 'pending';
}

export const SETTLEMENTS = ['released', 'refunded', 'reversed', 'force-released'] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

export const DISPUTE_STATES = ['active', 'pending', 'completed'] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

export const DISPUTE_OUTCOMES = ['refunded', 'released', 'evidence-requested', 'closed'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export const OUTCOME_STATE: Record<DisputeOutcome, DisputeState> = {
  refunded: 'completed',
  released: 'completed',
  'evidence-requested': 'pending',
  closed: 'completed',
};

export const OUTCOME_LABEL: Record<DisputeOutcome, string> = {
  refunded: 'Refunded to buyer',
  released: 'Payment released to seller',
  'evidence-requested': 'More evidence requested',
  closed: 'Closed without action',
};

export const CARRIERS = ['GIG Logistics', 'DHL Express', 'Red Star Express', 'Kwik Delivery', 'UPS'] as const;

/* --- Conversations ------------------------------------------------------- */

export const MESSAGE_KINDS = ['text', 'image', 'video', 'file', 'product', 'meetup', 'system', 'dispute', 'admin'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
/** What a participant may post directly; the rest are written by the platform. */
export const USER_MESSAGE_KINDS = ['text', 'image', 'video', 'file'] as const;
export type UserMessageKind = (typeof USER_MESSAGE_KINDS)[number];

export const OFFER_STATUSES = ['pending', 'accepted', 'declined', 'countered', 'withdrawn', 'used'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const MEETUP_STATUSES = ['proposed', 'accepted', 'declined'] as const;
export type MeetupStatus = (typeof MEETUP_STATUSES)[number];

/* --- Reviews ------------------------------------------------------------- */

export const REVIEW_ASPECTS = [
  'communication',
  'valueForMoney',
  'itemAsDescribed',
  'shippingSpeed',
  'professionalism',
  'responsiveness',
] as const;
export type ReviewAspect = (typeof REVIEW_ASPECTS)[number];
export const REVIEW_ASPECT_LABEL: Record<ReviewAspect, string> = {
  communication: 'Communication',
  valueForMoney: 'Value for Money',
  itemAsDescribed: 'Item as described',
  shippingSpeed: 'Shipping Speed',
  professionalism: 'Professionalism',
  responsiveness: 'Responsiveness',
};

/* --- Verification -------------------------------------------------------- */

export const ID_TYPES = ['drivers-license', 'passport', 'national-id'] as const;
export type IdType = (typeof ID_TYPES)[number];
export const ID_TYPE_LABEL: Record<IdType, string> = {
  'drivers-license': "Driver's License",
  passport: 'Passport',
  'national-id': 'National ID',
};

export const BANK_VERIFICATION_METHODS = ['instant', 'micro'] as const;
export type BankVerificationMethod = (typeof BANK_VERIFICATION_METHODS)[number];

/* --- Support ------------------------------------------------------------- */

export const SUPPORT_TOPICS = [
  'Dispute about my order',
  'Payment or escrow',
  'Delivery and shipping',
  'Account and settings',
  'Something else',
] as const;

/* --- Media --------------------------------------------------------------- */

export const MEDIA_PURPOSES = ['product', 'avatar', 'kyc', 'message', 'evidence', 'support', 'meetup', 'shipment', 'content'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
/** Identity documents never get a public URL. */
export const PRIVATE_MEDIA_PURPOSES: MediaPurpose[] = ['kyc'];
