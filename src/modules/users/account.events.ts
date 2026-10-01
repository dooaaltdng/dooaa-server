/**
 * Account lifecycle events. `closing` handlers may veto by throwing (open
 * orders, money in escrow); `closed` handlers tidy up after the fact.
 */
export const ACCOUNT_EVENTS = {
  closing: 'account.closing',
  closed: 'account.closed',
  statusChanged: 'account.status-changed',
  identityChanged: 'account.identity-changed',
} as const;

export type AccountClosing = { userId: string };
export type AccountClosed = { userId: string; email: string; firstName: string };
export type AccountStatusChanged = { userId: string; from: string; to: string; reason?: string };
export type AccountIdentityChanged = { userId: string; identity: string };
