import { randomBytes, randomInt } from 'node:crypto';

export function randomDigits(length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) out += String(randomInt(0, 10));
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** "482-301948271" — the order reference; the display number is `#` + this. */
export function orderReference(): string {
  return `${randomInt(100, 1000)}-${randomDigits(9)}`;
}

/** "#3588-A3849-6788" — the escrow ledger reference the admin tables print. */
export function escrowReference(): string {
  const letter = String.fromCharCode(65 + randomInt(0, 26));
  return `#${randomDigits(4)}-${letter}${randomDigits(4)}-${randomDigits(4)}`;
}

/** Our reference for a provider charge; also the idempotency key the provider sees. */
export function paymentReference(): string {
  return `DOO-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function payoutReference(): string {
  return `dooaa_po_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
}

export function refundReference(): string {
  return `dooaa_rf_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
}
