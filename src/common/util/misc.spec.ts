import { escrowReference, orderReference, paymentReference, randomDigits } from './ids';
import { paginateArray, pageWindow, toPage } from './pagination';
import { isUuid, uuidv7 } from './uuid';

describe('references', () => {
  it('generates the reference formats the apps print', () => {
    expect(orderReference()).toMatch(/^\d{3}-\d{9}$/);
    expect(escrowReference()).toMatch(/^#\d{4}-[A-Z]\d{4}-\d{4}$/);
    expect(paymentReference()).toMatch(/^DOO-[A-Z0-9]+-[A-F0-9]{8}$/);
    expect(randomDigits(6)).toMatch(/^\d{6}$/);
  });

  it('is unique enough not to collide in practice', () => {
    const seen = new Set(Array.from({ length: 2_000 }, () => orderReference()));
    expect(seen.size).toBe(2_000);
  });

});

describe('uuid', () => {
  it('mints version 7 ids that sort by time', () => {
    const earlier = uuidv7(Date.UTC(2026, 0, 1));
    const later = uuidv7(Date.UTC(2026, 0, 2));
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(earlier < later).toBe(true);
    expect(new Set(Array.from({ length: 1_000 }, () => uuidv7())).size).toBe(1_000);
  });

  it('recognises record ids', () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid('0190f8f5-3b1c-7e4a-9d2c-1f2e3d4c5b6a')).toBe(true);
    expect(isUuid('65f0c0ffee0000000000abcd')).toBe(false);
    expect(isUuid('123')).toBe(false);
    expect(isUuid(12)).toBe(false);
  });
});

describe('pagination', () => {
  it('clamps the page into range like the admin pager', () => {
    expect(pageWindow(32, 1, 7)).toEqual({ page: 1, size: 7, skip: 0, pageCount: 5 });
    expect(pageWindow(32, 9, 7)).toEqual({ page: 5, size: 7, skip: 28, pageCount: 5 });
    expect(pageWindow(0, 3, 7)).toEqual({ page: 1, size: 7, skip: 0, pageCount: 1 });
  });

  it('reports the "Showing 1 to 7 of 32" span', () => {
    expect(toPage([1, 2, 3, 4, 5, 6, 7], 32, pageWindow(32, 1, 7))).toMatchObject({ from: 1, to: 7, total: 32, pageCount: 5 });
    expect(paginateArray(Array.from({ length: 32 }, (_, i) => i), 5, 7)).toMatchObject({ rows: [28, 29, 30, 31], from: 29, to: 32, page: 5 });
    expect(paginateArray([], 1, 7)).toMatchObject({ rows: [], from: 0, to: 0, total: 0 });
  });
});
