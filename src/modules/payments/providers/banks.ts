import type { Bank } from './payment-provider';

/** Nigerian banks and wallets with their NIBSS/Paystack codes (sandbox list). */
export const NIGERIAN_BANKS: Bank[] = [
  { name: 'Access Bank', code: '044', slug: 'access-bank' },
  { name: 'Ecobank Nigeria', code: '050', slug: 'ecobank-nigeria' },
  { name: 'Fidelity Bank', code: '070', slug: 'fidelity-bank' },
  { name: 'First Bank of Nigeria', code: '011', slug: 'first-bank-of-nigeria' },
  { name: 'First City Monument Bank', code: '214', slug: 'first-city-monument-bank' },
  { name: 'Guaranty Trust Bank', code: '058', slug: 'guaranty-trust-bank' },
  { name: 'Kuda Bank', code: '50211', slug: 'kuda-bank' },
  { name: 'Moniepoint MFB', code: '50515', slug: 'moniepoint-mfb-ng' },
  { name: 'OPay Digital Services', code: '999992', slug: 'paycom' },
  { name: 'PalmPay', code: '999991', slug: 'palmpay' },
  { name: 'Polaris Bank', code: '076', slug: 'polaris-bank' },
  { name: 'Providus Bank', code: '101', slug: 'providus-bank' },
  { name: 'Stanbic IBTC Bank', code: '221', slug: 'stanbic-ibtc-bank' },
  { name: 'Sterling Bank', code: '232', slug: 'sterling-bank' },
  { name: 'Union Bank of Nigeria', code: '032', slug: 'union-bank-of-nigeria' },
  { name: 'United Bank For Africa', code: '033', slug: 'united-bank-for-africa' },
  { name: 'Wema Bank', code: '035', slug: 'wema-bank' },
  { name: 'Zenith Bank', code: '057', slug: 'zenith-bank' },
];
