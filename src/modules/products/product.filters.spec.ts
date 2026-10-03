import { buildCatalogFilter, catalogSort, normalizeCondition, sellerVerificationFilter } from './product.filters';

describe('catalog filters', () => {
  it('reads the storefront condition labels', () => {
    expect(normalizeCondition('Brand New')).toBe('new');
    expect(normalizeCondition('New')).toBe('new');
    expect(normalizeCondition('Slightly Used')).toBe('slightly-used');
    expect(normalizeCondition('refurbished')).toBe('refurbished');
    expect(normalizeCondition('Mint')).toBeNull();
  });

  it('treats both seller facets together as no filter', () => {
    expect(sellerVerificationFilter(undefined)).toBeNull();
    expect(sellerVerificationFilter(['Verified sellers'])).toBe(true);
    expect(sellerVerificationFilter(['Unverified sellers'])).toBe(false);
    expect(sellerVerificationFilter(['Verified sellers', 'Unverified sellers'])).toBeNull();
  });

  it('combines the price band with explicit bounds, keeping the narrower range', () => {
    const filter = buildCatalogFilter({ price: '300k-500k', min: 350_000 }, 'none') as Record<string, any>;
    expect(filter.price).toEqual({ $gte: 350_000, $lt: 500_000 });
    expect(filter.status).toBe('active');
    expect(filter.deletedAt).toBeNull();
  });

  it('searches by text or by substring, escaping what the visitor typed', () => {
    expect((buildCatalogFilter({ q: 'iphone' }, 'text') as Record<string, any>).$text).toEqual({ $search: 'iphone' });
    const regex = buildCatalogFilter({ q: 'i(p' }, 'regex') as Record<string, any>;
    expect(regex.$and[0].$or[0].title.source).toBe('i\\(p');
  });

  it('sorts newest, oldest and by price, with a stable tie-breaker', () => {
    expect(catalogSort({ sort: 'newest' }, 'none')).toEqual({ publishedAt: -1, createdAt: -1, _id: -1 });
    expect(catalogSort({ sort: 'oldest' }, 'none')).toEqual({ publishedAt: 1, createdAt: 1, _id: 1 });
    expect(catalogSort({ sort: 'price-asc' }, 'text')).toEqual({ price: 1, _id: 1 });
    expect(catalogSort({ collection: 'popular' }, 'none')).toEqual({ 'stats.views': -1, 'stats.wishlists': -1, _id: -1 });
    expect(catalogSort({}, 'text')).toEqual({ score: { $meta: 'textScore' }, _id: -1 });
  });
});
