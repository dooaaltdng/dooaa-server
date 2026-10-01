import { TtlCache } from './cache';
import { escrowReference, idOf, isObjectId, orderReference, paymentReference, randomDigits } from './ids';
import { paginateArray, pageWindow, toPage } from './pagination';
import { Types } from 'mongoose';

describe('TtlCache', () => {
  it('returns values until they expire', async () => {
    const cache = new TtlCache<number>(20);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cache.get('a')).toBeUndefined();
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new TtlCache<number>(1_000);
    let loads = 0;
    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 42;
    };
    const values = await Promise.all([cache.wrap('k', load), cache.wrap('k', load), cache.wrap('k', load)]);
    expect(values).toEqual([42, 42, 42]);
    expect(loads).toBe(1);
  });

  it('evicts the oldest entry at capacity and forgets on delete', () => {
    const cache = new TtlCache<number>(1_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    cache.delete('b');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('does not cache a failed load', async () => {
    const cache = new TtlCache<number>(1_000);
    await expect(cache.wrap('x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cache.wrap('x', async () => 7)).toBe(7);
  });
});

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

  it('recognises object ids', () => {
    const id = new Types.ObjectId();
    expect(isObjectId(id.toHexString())).toBe(true);
    expect(isObjectId('123')).toBe(false);
    expect(isObjectId(12)).toBe(false);
    expect(idOf(id)).toBe(id.toHexString());
    expect(idOf({ _id: id })).toBe(id.toHexString());
    expect(idOf(null)).toBeUndefined();
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
