/**
 * Identifies a file from its first bytes. The browser-supplied MIME type is
 * never trusted: a renamed script uploaded as "photo.jpg" is rejected here.
 */
export type Sniffed = { mime: string; ext: string; kind: 'image' | 'video' | 'file' };

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString('latin1');
}

export function sniff(buffer: Buffer): Sniffed | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: '.jpg', kind: 'image' };
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: '.png', kind: 'image' };
  if (ascii(buffer, 0, 6) === 'GIF87a' || ascii(buffer, 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: '.gif', kind: 'image' };
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp', kind: 'image' };
  if (ascii(buffer, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: '.pdf', kind: 'file' };
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', ext: '.webm', kind: 'video' };
  if (ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) return { mime: 'image/heic', ext: '.heic', kind: 'image' };
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', ext: '.mov', kind: 'video' };
    return { mime: 'video/mp4', ext: '.mp4', kind: 'video' };
  }
  return null;
}
