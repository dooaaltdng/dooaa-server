import { randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A version 7 UUID (RFC 9562): 48 bits of Unix milliseconds, then random
 * bits. Ids generated this way sort by creation time, which keeps primary
 * key indexes append-only.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let time = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Any well-formed UUID (record ids are UUIDs). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
