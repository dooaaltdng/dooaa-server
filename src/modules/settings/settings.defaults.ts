import {
  DEFAULT_REGIONS,
  DEFAULT_ROLE_PERMISSIONS,
  type RolePermissions,
} from '../../common/domain';

/** The twelve-category marketplace taxonomy, by slug (the client's /categories/[slug] routes). */
export const DEFAULT_CATEGORY_SLUGS = [
  'automative',
  'beauty-health',
  'books',
  'home-appliances',
  'gatdgets',
  'fashion',
  'sports',
  'toys-games',
  'properties',
  'musical-instruments',
  'babies-kids',
  'gym-wears',
];

export type EscrowSettings = {
  /**
   * Off by default: buyers chat a marketplace seller and settle between
   * themselves. On, escrow sits inside that chat — offers agree a price and
   * the buyer pays into escrow from the thread.
   */
  enabled: boolean;
  /** Buyer-paid escrow fee, a percentage of the item price. */
  feePercent: number;
  /** Floor on the escrow fee, in Naira. */
  minimumFee: number;
  /** How long after delivery funds release without the buyer confirming. */
  autoReleaseDays: number;
  /** Rails a seller can be paid out on. */
  payoutMethods: string[];
};

export type DisputeSettings = {
  responseHours: number;
  reopenDays: number;
  returnWindowDays: number;
  nonDeliveryWindowDays: number;
  settlementDays: string;
};

export type ModerationSettings = {
  /** Off means a new listing enters the queue as Pending. */
  autoPublishListings: boolean;
  /** Categories that always queue for review. */
  reviewCategories: string[];
  /** A price this many times the category median flags a listing Suspicious. */
  suspiciousPriceMultiple: number;
  /** Listings priced above this need a High-Value seller, or they queue for review. */
  requireKycAboveAmount: number;
};

export type MarketplaceSettings = {
  activeCategories: string[];
  regions: string[];
};

export type NotificationSettings = {
  newDispute: boolean;
  suspiciousListing: boolean;
  highValueTransaction: boolean;
  kycSubmission: boolean;
  highValueThreshold: number;
};

/** Checkout and payout knobs the console did not draw but the money flows need. */
export type CommerceSettings = {
  /** Courier fee per seller on a cart checkout, in Naira. */
  deliveryFee: number;
  /** Courier fee on a Buy-via-Escrow purchase. */
  escrowDeliveryFee: number;
  /** VAT charged on the discounted subtotal, as a percentage. 0 disables tax. */
  taxRate: number;
  /** DOOAA's commission on the item subtotal, as a percentage, deducted from the seller's earning. */
  commissionPercent: number;
  minimumWithdrawal: number;
  /** The seller's dispatch window after payment. */
  shipWithinHours: number;
  /** Days added to the ship date for the buyer's delivery estimate. */
  deliveryEstimateDays: number;
  /** Unpaid checkouts are cancelled after this long. */
  unpaidOrderTtlMinutes: number;
  /** Pay released earnings out to the seller's primary bank automatically. */
  autoPayout: boolean;
};

/**
 * The console's Features page: each marketplace feature a user can touch, on
 * or off. Escrow is not here — it is `escrow.enabled`, which the Features page
 * reads and writes too.
 */
export const FEATURE_FLAGS = [
  'checkout',
  'coupons',
  'search',
  'selling',
  'payouts',
  'seller-analytics',
  'verification',
  'reviews',
  'messaging',
  'offers',
  'meetups',
  'disputes',
  'cancellations',
  'sign-ups',
  'social-sign-in',
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FeatureSettings = Record<FeatureFlag, boolean>;

/** What a user sees when they reach a switched-off feature through the API. */
export const FEATURE_OFF_MESSAGE: Record<FeatureFlag, string> = {
  checkout: 'Buying through the cart is switched off right now.',
  coupons: 'Coupons are switched off right now.',
  search: 'Search suggestions are switched off right now.',
  selling: 'New selling is switched off right now.',
  payouts: 'Payouts are paused right now.',
  'seller-analytics': 'Seller analytics are switched off right now.',
  verification: 'Identity verification is switched off right now.',
  reviews: 'Reviews are switched off right now.',
  messaging: 'Messaging is switched off right now.',
  offers: 'Offers are switched off right now.',
  meetups: 'Meetups are switched off right now.',
  disputes: 'Disputes are switched off right now. Contact support instead.',
  cancellations: 'Cancellation requests are switched off right now. Message the seller instead.',
  'sign-ups': 'New sign-ups are closed right now.',
  'social-sign-in': 'Social sign-in is switched off right now. Use your email instead.',
};

export type PlatformSettings = {
  escrow: EscrowSettings;
  disputes: DisputeSettings;
  moderation: ModerationSettings;
  marketplace: MarketplaceSettings;
  notifications: NotificationSettings;
  roles: RolePermissions;
  commerce: CommerceSettings;
  features: FeatureSettings;
};

export type SettingsSection = keyof PlatformSettings;
export const SETTINGS_SECTIONS: SettingsSection[] = [
  'escrow',
  'disputes',
  'moderation',
  'marketplace',
  'notifications',
  'roles',
  'commerce',
  'features',
];

export const PAYOUT_METHODS = ['Bank Transfer', 'Card — Verve', 'Credit Card', 'USSD'] as const;

export function defaultSettings(): PlatformSettings {
  return {
    escrow: {
      enabled: false,
      feePercent: 0.5,
      minimumFee: 500,
      autoReleaseDays: 7,
      payoutMethods: ['Bank Transfer'],
    },
    disputes: {
      responseHours: 24,
      reopenDays: 7,
      returnWindowDays: 7,
      nonDeliveryWindowDays: 14,
      settlementDays: '3–5',
    },
    moderation: {
      autoPublishListings: false,
      reviewCategories: ['automative', 'properties'],
      suspiciousPriceMultiple: 3,
      requireKycAboveAmount: 1_000_000,
    },
    marketplace: {
      activeCategories: [...DEFAULT_CATEGORY_SLUGS],
      regions: [...DEFAULT_REGIONS],
    },
    notifications: {
      newDispute: true,
      suspiciousListing: true,
      highValueTransaction: true,
      kycSubmission: true,
      highValueThreshold: 1_000_000,
    },
    roles: structuredClone(DEFAULT_ROLE_PERMISSIONS),
    commerce: {
      deliveryFee: 5_000,
      escrowDeliveryFee: 5_000,
      taxRate: 0,
      commissionPercent: 0,
      minimumWithdrawal: 1_000,
      shipWithinHours: 48,
      deliveryEstimateDays: 3,
      unpaidOrderTtlMinutes: 60,
      autoPayout: false,
    },
    // Everything on: the marketplace as it is built today.
    features: Object.fromEntries(FEATURE_FLAGS.map((flag) => [flag, true])) as FeatureSettings,
  };
}
