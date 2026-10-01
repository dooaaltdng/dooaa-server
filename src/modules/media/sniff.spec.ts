import { sniff } from './sniff';

const bytes = (...values: number[]) => Buffer.from(values);

describe('sniff', () => {
  it.each([
    ['jpeg', Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(8)]), 'image/jpeg', 'image'],
    ['png', Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(8)]), 'image/png', 'image'],
    ['gif', Buffer.from('GIF89a......'), 'image/gif', 'image'],
    ['webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp', 'image'],
    ['pdf', Buffer.from('%PDF-1.7\n'), 'application/pdf', 'file'],
    ['webm', Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.alloc(8)]), 'video/webm', 'video'],
    ['mp4', Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypisom'), Buffer.alloc(4)]), 'video/mp4', 'video'],
    ['mov', Buffer.concat([bytes(0, 0, 0, 0x14), Buffer.from('ftypqt  '), Buffer.alloc(4)]), 'video/quicktime', 'video'],
    ['heic', Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypheic'), Buffer.alloc(4)]), 'image/heic', 'image'],
  ])('recognises %s', (_name, buffer, mime, kind) => {
    expect(sniff(buffer)).toMatchObject({ mime, kind });
  });

  it.each([
    ['html', Buffer.from('<html><script>alert(1)</script>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['exe', Buffer.from('MZ\x90\x00')],
    ['empty', Buffer.alloc(0)],
  ])('refuses %s', (_name, buffer) => {
    expect(sniff(buffer)).toBeNull();
  });
});
