import { createTestApp, type TestApp } from './utils/app';
import { Http, data, failure } from './utils/http';
import { eventually } from './utils/eventually';
import { createProduct, model, registerSeller, registerUser, setSettings, staffToken, uploadImage } from './utils/factories';
import { WishlistItem } from '../src/modules/wishlist/wishlist.schema';
import { Product } from '../src/modules/products/schemas/product.schema';
import { Types } from 'mongoose';

describe('Catalog (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let seller: Awaited<ReturnType<typeof registerSeller>>;
  let unverifiedSeller: Awaited<ReturnType<typeof registerSeller>>;

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    seller = await registerSeller(t, { storeName: 'Nelson Stores' });
    unverifiedSeller = await registerSeller(t, { verifiedIdentity: false });

    // A small, varied catalogue.
    await createProduct(t, seller.id, { title: 'Apple iPhone 12 Pro 512 GB Blue', price: 400_000, condition: 'used', brand: 'Apple', categoryId: 'gatdgets' });
    await createProduct(t, seller.id, { title: 'Samsung Galaxy S23 Ultra 5G Phantom Black', price: 1_280_000, condition: 'new', brand: 'Samsung', categoryId: 'gatdgets', stats: { unitsSold: 40, views: 10 } });
    await createProduct(t, seller.id, { title: 'Tecno Camon 20 Pro', price: 250_000, condition: 'new', brand: 'Tecno', categoryId: 'gatdgets', stats: { views: 500 } });
    await createProduct(t, unverifiedSeller.id, { title: 'Itel A70 budget phone', price: 95_000, condition: 'refurbished', brand: 'Itel', sellerVerified: false, location: 'Wuse, Abuja' });
    await createProduct(t, seller.id, { title: 'Toyota Corolla 2016 Neat', price: 9_800_000, condition: 'used', brand: 'Toyota', categoryId: 'automative', featured: true });
    await createProduct(t, seller.id, { title: 'Nike Air Force 1 White 43', price: 95_000, condition: 'new', brand: 'Nike', categoryId: 'fashion', stock: 0 });
    await createProduct(t, seller.id, { title: 'Hidden draft listing', status: 'draft' });
    await createProduct(t, seller.id, { title: 'Pending listing awaiting review', status: 'pending' });
    await createProduct(t, seller.id, { title: 'Deleted listing', deletedAt: new Date() });
  });
  afterAll(async () => t.close());

  describe('categories', () => {
    it('lists the twelve-category taxonomy with live product counts', async () => {
      const categories = data(await http.get('/categories'));
      expect(categories).toHaveLength(12);
      expect(categories[0]).toMatchObject({ id: 'automative', slug: 'automative', name: 'Automotive', productCount: 1 });
      expect(categories.find((category: any) => category.slug === 'gatdgets')).toMatchObject({ name: 'Gadgets', productCount: 4 });
    });

    it('gets one category and 404s on unknown slugs', async () => {
      expect(data(await http.get('/categories/fashion'))).toMatchObject({ name: 'Fashion', productCount: 1 });
      failure(await http.get('/categories/spaceships'), 404, 'CATEGORY_NOT_FOUND');
    });
  });

  describe('search', () => {
    it('shows only live listings, newest first, with card fields', async () => {
      const page = data(await http.get('/products'));
      expect(page.total).toBe(6);
      const titles = page.rows.map((row: any) => row.title);
      expect(titles).not.toContain('Hidden draft listing');
      expect(titles).not.toContain('Pending listing awaiting review');
      expect(titles).not.toContain('Deleted listing');
      expect(page.rows[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          price: expect.any(Number),
          condition: expect.any(String),
          conditionLabel: expect.any(String),
          image: expect.any(String),
          categoryName: expect.any(String),
          verifiedSeller: expect.any(Boolean),
          inStock: expect.any(Boolean),
          wishlisted: false,
        }),
      );
    });

    it('filters by category, condition label, brand, seller verification and price', async () => {
      expect(data(await http.get('/products?category=automative')).total).toBe(1);
      expect(data(await http.get('/products?category=automative&category=fashion')).total).toBe(2);
      expect(data(await http.get('/products?condition=Brand%20New')).rows.every((row: any) => row.condition === 'new')).toBe(true);
      expect(data(await http.get('/products?brand=apple')).rows.map((row: any) => row.brand)).toEqual(['Apple']);
      expect(data(await http.get('/products?seller=Unverified%20sellers')).rows.map((row: any) => row.brand)).toEqual(['Itel']);
      expect(data(await http.get('/products?seller=Verified%20sellers&seller=Unverified%20sellers')).total).toBe(6);
      expect(data(await http.get('/products?price=under-300k')).rows.every((row: any) => row.price < 300_000)).toBe(true);
      expect(data(await http.get('/products?min=300000&max=1300000')).rows.map((row: any) => row.price).sort()).toEqual([1_280_000, 400_000].sort());
      expect(data(await http.get('/products?inStock=true')).total).toBe(5);
    });

    it('sorts by price and recency', async () => {
      const ascending = data(await http.get('/products?sort=price-asc')).rows.map((row: any) => row.price);
      expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
      const descending = data(await http.get('/products?sort=price-desc')).rows.map((row: any) => row.price);
      expect(descending[0]).toBe(9_800_000);
    });

    it('searches whole words by relevance and falls back to partial words', async () => {
      expect(data(await http.get('/products?q=galaxy')).rows[0].title).toContain('Galaxy');
      const partial = data(await http.get('/products?q=iph'));
      expect(partial.total).toBe(1);
      expect(partial.rows[0].title).toContain('iPhone');
      expect(data(await http.get('/products?q=abuja')).rows[0].brand).toBe('Itel');
      expect(data(await http.get('/products?q=%28%2A.%2B')).total).toBe(0);
    });

    it('returns facets for the sidebar', async () => {
      const { facets } = data(await http.get('/products?category=gatdgets'));
      expect(facets.brands).toEqual(expect.arrayContaining([{ value: 'Apple', count: 1 }, { value: 'Itel', count: 1 }]));
      expect(facets.sellers).toEqual({ verified: 3, unverified: 1 });
      expect(facets.price).toEqual({ min: 95_000, max: 1_280_000 });
    });

    it('pages like the admin tables, clamping out-of-range pages', async () => {
      const first = data(await http.get('/products?limit=4&page=1'));
      expect(first).toMatchObject({ total: 6, pageCount: 2, from: 1, to: 4 });
      const last = data(await http.get('/products?limit=4&page=99'));
      expect(last).toMatchObject({ page: 2, from: 5, to: 6 });
    });

    it('orders the top-sellers and popular collections', async () => {
      expect(data(await http.get('/products?collection=top-sellers')).rows[0].brand).toBe('Samsung');
      expect(data(await http.get('/products?collection=popular')).rows[0].brand).toBe('Tecno');
      expect(data(await http.get('/products?collection=featured')).rows.map((row: any) => row.brand)).toEqual(['Toyota']);
    });

    it('validates the query string', async () => {
      failure(await http.get('/products?limit=500'), 400, 'VALIDATION_FAILED');
      failure(await http.get('/products?sort=cheapest'), 400, 'VALIDATION_FAILED');
      failure(await http.get('/products?min=-1'), 400, 'VALIDATION_FAILED');
    });

    it('suggests titles as you type', async () => {
      const suggestions = data(await http.get('/products/suggest?q=sams'));
      expect(suggestions[0]).toMatchObject({ title: 'Samsung Galaxy S23 Ultra 5G Phantom Black', categoryId: 'gatdgets' });
    });
  });

  describe('home and detail', () => {
    it('builds the landing page: six tiles and three rails', async () => {
      const home = data(await http.get('/catalog/home'));
      expect(home.categories.map((tile: any) => tile.name)).toEqual(['Vehicles', 'Electronics', 'Fashion', 'Property', 'Gadget', 'Home Appliances']);
      expect(home.topSellers[0].brand).toBe('Samsung');
      expect(home.popular[0].brand).toBe('Tecno');
      expect(home.featured[0].brand).toBe('Toyota');
      // Out-of-stock items stay off the rails.
      expect(home.popular.map((card: any) => card.brand)).not.toContain('Nike');
    });

    it('shows the full product page with the seller panel and related items', async () => {
      const iphone = data(await http.get('/products?q=iphone')).rows[0];
      const detail = data(await http.get(`/products/${iphone.id}`));
      expect(detail).toMatchObject({
        id: iphone.id,
        gallery: [expect.any(String)],
        specs: ['512GB storage', 'Battery health 89%'],
        deliveryLabel: 'Nationwide delivery',
        breadcrumb: ['Home', 'Gadgets'],
        seller: { name: 'Sola Seller', storeName: 'Nelson Stores', verified: true, dispatch: 'Delivery within 3 days' },
      });
      expect(detail.alsoViewed.length).toBeGreaterThan(0);
      expect(detail.alsoViewed.every((card: any) => card.categoryId === 'gatdgets' && card.id !== iphone.id)).toBe(true);
    });

    it('counts views from shoppers but not from the seller', async () => {
      const product = await createProduct(t, seller.id, { title: 'View counter test' });
      const buyer = await registerUser(t);
      data(await http.get(`/products/${product._id}`, buyer.token));
      data(await http.get(`/products/${product._id}`));
      data(await http.get(`/products/${product._id}`, seller.token));
      await eventually(async () => {
        const stored = await model<Product>(t, Product.name).findById(product._id).lean();
        expect(stored?.stats.views).toBe(2);
      });
      // …and the seller's own visit never lands later.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect((await model<Product>(t, Product.name).findById(product._id).lean())?.stats.views).toBe(2);
    });

    it('hides listings that are not live', async () => {
      const draft = await model<Product>(t, Product.name).findOne({ title: 'Hidden draft listing' }).lean();
      failure(await http.get(`/products/${draft!._id}`), 404, 'PRODUCT_NOT_FOUND');
      failure(await http.get(`/products/${new Types.ObjectId()}`), 404, 'PRODUCT_NOT_FOUND');
      failure(await http.get('/products/not-an-id'), 404);
    });

    it('marks wishlisted cards for a signed-in shopper', async () => {
      const buyer = await registerUser(t);
      const iphone = data(await http.get('/products?q=iphone')).rows[0];
      await model<WishlistItem>(t, WishlistItem.name).create({ userId: new Types.ObjectId(buyer.id), productId: new Types.ObjectId(iphone.id) });
      const page = data(await http.get('/products?q=iphone', buyer.token));
      expect(page.rows[0].wishlisted).toBe(true);
      expect(data(await http.get(`/products/${iphone.id}`, buyer.token)).wishlisted).toBe(true);
    });

    it('lists a seller’s storefront', async () => {
      const page = data(await http.get(`/sellers/${unverifiedSeller.id}/products`));
      expect(page.rows.map((row: any) => row.brand)).toEqual(['Itel']);
    });
  });

  describe('seller listings', () => {
    const listing = (images: string[], overrides: Record<string, unknown> = {}) => ({
      title: 'Sony WH-1000XM5 Headphones',
      description: 'Industry-leading noise cancellation with 30 hours of battery life.',
      additional: undefined,
      highlights: ['30-hour battery', 'Multipoint'],
      price: 385_000,
      pricing: 'negotiable',
      condition: 'Brand New',
      stock: 10,
      categoryId: 'gatdgets',
      brand: 'Sony',
      delivery: 'nationwide',
      paymentMethod: 'escrow',
      images,
      ...overrides,
    });

    it('keeps the seller tools to sellers', async () => {
      const buyer = await registerUser(t);
      failure(await http.get('/seller/products', buyer.token), 403, 'ROLE_REQUIRED');
    });

    it('saves a draft without photos, then refuses to publish it until it has one', async () => {
      const body = listing([]);
      delete (body as Record<string, unknown>).additional;
      const draft = data(await http.post('/seller/products', { ...body, publish: false }, seller.token));
      expect(draft).toMatchObject({ status: 'draft', displayStatus: 'draft', condition: 'new', pricing: 'negotiable' });
      failure(await http.patch(`/seller/products/${draft.id}/status`, { status: 'active' }, seller.token), 400, 'IMAGES_REQUIRED');
    });

    it('only accepts photos the seller uploaded', async () => {
      const body = listing(['https://evil.example.com/photo.jpg']);
      delete (body as Record<string, unknown>).additional;
      failure(await http.post('/seller/products', { ...body, publish: true }, seller.token), 400, 'MEDIA_NOT_FOUND');
      const someoneElses = await uploadImage(t, unverifiedSeller.token);
      failure(await http.post('/seller/products', { ...body, images: [someoneElses], publish: true }, seller.token), 400, 'MEDIA_NOT_FOUND');
    });

    it('queues listings for review while the console requires it', async () => {
      const image = await uploadImage(t, seller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      const created = data(await http.post('/seller/products', { ...body, publish: true }, seller.token));
      expect(created).toMatchObject({ status: 'pending', moderationFlags: ['manual-review'] });
    });

    it('publishes straight away when auto-publish is on and nothing needs a look', async () => {
      await setSettings(t, 'moderation', { autoPublishListings: true });
      const image = await uploadImage(t, seller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      const created = data(await http.post('/seller/products', { ...body, publish: true }, seller.token));
      expect(created).toMatchObject({ status: 'active', displayStatus: 'active', moderationFlags: [] });
      expect(data(await http.get(`/products/${created.id}`)).title).toBe('Sony WH-1000XM5 Headphones');
    });

    it('still queues unverified sellers, review categories and high-value items', async () => {
      await setSettings(t, 'moderation', { autoPublishListings: true });
      const image = await uploadImage(t, unverifiedSeller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      expect(data(await http.post('/seller/products', { ...body, publish: true }, unverifiedSeller.token)).moderationFlags).toEqual(['unverified-seller']);

      const carPhoto = await uploadImage(t, seller.token);
      const car = data(await http.post('/seller/products', { ...body, images: [carPhoto], categoryId: 'automative', price: 500_000, publish: true }, seller.token));
      expect(car).toMatchObject({ status: 'pending', moderationFlags: ['review-category'] });

      const pricey = await uploadImage(t, seller.token);
      const highValue = data(await http.post('/seller/products', { ...body, images: [pricey], price: 2_000_000, categoryId: 'fashion', publish: true }, seller.token));
      expect(highValue.moderationFlags).toEqual(['high-value']);
    });

    it('flags a price far above the category median as suspicious', async () => {
      await setSettings(t, 'moderation', { autoPublishListings: true, requireKycAboveAmount: 1_000_000_000 });
      for (let index = 0; index < 5; index += 1) await createProduct(t, seller.id, { categoryId: 'books', price: 10_000 + index * 1_000, title: `Novel ${index}` });
      const image = await uploadImage(t, seller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      const outlier = data(await http.post('/seller/products', { ...body, categoryId: 'books', price: 900_000, publish: true }, seller.token));
      expect(outlier).toMatchObject({ status: 'suspicious', moderationFlags: ['price-outlier'] });
    });

    it('refuses escrow listings while escrow is off, and closed categories', async () => {
      await setSettings(t, 'escrow', { enabled: false });
      const body = listing([]);
      delete (body as Record<string, unknown>).additional;
      failure(await http.post('/seller/products', body, seller.token), 400, 'ESCROW_DISABLED');
      data(await http.post('/seller/products', { ...body, paymentMethod: 'default' }, seller.token));
      await setSettings(t, 'escrow', { enabled: true });

      const settings = data(await http.get('/settings/public'));
      await setSettings(t, 'marketplace', { activeCategories: settings.marketplace.activeCategories.filter((slug: string) => slug !== 'books') });
      failure(await http.post('/seller/products', { ...body, categoryId: 'books' }, seller.token), 400, 'CATEGORY_CLOSED');
      failure(await http.post('/seller/products', { ...body, categoryId: 'spaceships' }, seller.token), 400, 'UNKNOWN_CATEGORY');
      await setSettings(t, 'marketplace', { activeCategories: settings.marketplace.activeCategories });
    });

    it('edits a listing, keeping the previous price and re-checking a live one', async () => {
      await setSettings(t, 'moderation', { autoPublishListings: true, requireKycAboveAmount: 1_000_000_000 });
      const image = await uploadImage(t, seller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      const created = data(await http.post('/seller/products', { ...body, publish: true }, seller.token));
      const updated = data(await http.patch(`/seller/products/${created.id}`, { price: 350_000, stock: 0, description: 'Now even better, barely used for a week.' }, seller.token));
      expect(updated).toMatchObject({ price: 350_000, previousPrice: 385_000, displayStatus: 'out-of-stock', stockStatus: 'out-of-stock', status: 'active' });
      expect(updated.description).toBe('Now even better, barely used for a week.');
    });

    it('lists the seller’s tabs with counts', async () => {
      const result = data(await http.get('/seller/products?tab=draft', seller.token));
      expect(result.rows.every((row: any) => row.status === 'draft')).toBe(true);
      expect(result.counts.all).toBe(result.counts.active + result.counts.inactive + result.counts.draft);
      const inactive = data(await http.get('/seller/products?tab=inactive', seller.token));
      expect(inactive.rows.every((row: any) => row.displayStatus !== 'active' && row.displayStatus !== 'draft')).toBe(true);
    });

    it('filters the seller’s listings by the status pill they show', async () => {
      await setSettings(t, 'moderation', { autoPublishListings: true, requireKycAboveAmount: 1_000_000_000 });
      const image = await uploadImage(t, seller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      const live = data(await http.post('/seller/products', { ...body, title: 'Filter Live Speaker', publish: true }, seller.token));
      const soldOut = data(await http.post('/seller/products', { ...body, title: 'Filter Sold Out Speaker', images: [await uploadImage(t, seller.token)], publish: true }, seller.token));
      data(await http.patch(`/seller/products/${soldOut.id}`, { stock: 0 }, seller.token));

      const ids = (page: { rows: { id: string }[] }) => page.rows.map((row) => row.id);
      const active = data(await http.get('/seller/products?status=active&limit=100', seller.token));
      expect(ids(active)).toContain(live.id);
      expect(ids(active)).not.toContain(soldOut.id);
      expect(active.rows.every((row: any) => row.displayStatus === 'active')).toBe(true);

      const out = data(await http.get('/seller/products?status=out-of-stock&limit=100', seller.token));
      expect(ids(out)).toEqual(expect.arrayContaining([soldOut.id]));
      expect(out.rows.every((row: any) => row.displayStatus === 'out-of-stock')).toBe(true);

      // Combined with a tab: a sold-out listing is never in the Active tab.
      expect(ids(data(await http.get('/seller/products?tab=active&status=out-of-stock', seller.token)))).toEqual([]);
      const pending = data(await http.get('/seller/products?status=pending&limit=100', seller.token));
      expect(pending.rows.every((row: any) => ['pending', 'suspicious'].includes(row.status))).toBe(true);
      failure(await http.get('/seller/products?status=vanished', seller.token), 400, 'VALIDATION_FAILED');
    });

    it('unpublishes and deletes; other sellers cannot touch the listing', async () => {
      await setSettings(t, 'moderation', { autoPublishListings: true, requireKycAboveAmount: 1_000_000_000 });
      const image = await uploadImage(t, seller.token);
      const body = listing([image]);
      delete (body as Record<string, unknown>).additional;
      const created = data(await http.post('/seller/products', { ...body, publish: true }, seller.token));
      failure(await http.patch(`/seller/products/${created.id}`, { price: 1 }, unverifiedSeller.token), 404, 'PRODUCT_NOT_FOUND');
      expect(data(await http.patch(`/seller/products/${created.id}/status`, { status: 'inactive' }, seller.token)).status).toBe('inactive');
      failure(await http.get(`/products/${created.id}`), 404);
      data(await http.delete(`/seller/products/${created.id}`, seller.token));
      failure(await http.get(`/seller/products/${created.id}`, seller.token), 404, 'PRODUCT_NOT_FOUND');
    });
  });

  describe('console listings', () => {
    it('searches by seller and filters by status', async () => {
      const admin = await staffToken(t, 'admin');
      const page = data(await http.get('/admin/listings?search=Sola&statuses=pending', admin.token));
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.every((row: any) => row.status === 'pending' && row.sellerName === 'Sola Seller')).toBe(true);
      expect(page.rows[0]).toEqual(expect.objectContaining({ sellerEmail: seller.email, media: expect.any(Array), listedAs: 'seller' }));
    });

    it('lets moderators approve but not delete, and audits both', async () => {
      const moderator = await staffToken(t, 'moderator', { firstName: 'Amara', lastName: 'Eze' });
      const pending = await createProduct(t, seller.id, { title: 'Awaiting moderation', status: 'pending' });
      const approved = data(await http.patch(`/admin/listings/${pending._id}/status`, { status: 'active', note: 'Looks genuine' }, moderator.token));
      expect(approved.status).toBe('active');
      failure(await http.delete(`/admin/listings/${pending._id}`, moderator.token), 403, 'PERMISSION_DENIED');

      const admin = await staffToken(t, 'admin');
      data(await http.delete(`/admin/listings/${pending._id}`, admin.token));
      failure(await http.get(`/admin/listings/${pending._id}`, admin.token), 404);
      const log = data(await http.get('/admin/audit?search=Awaiting', admin.token));
      expect(log.rows.map((row: any) => row.action)).toEqual(expect.arrayContaining(['Approved a listing', 'Deleted a listing']));
    });

    it('creates official listings under the DOOAA store and can feature them', async () => {
      const admin = await staffToken(t, 'admin');
      const image = await uploadImage(t, admin.token, 'product', true);
      const created = data(
        await http.post(
          '/admin/listings',
          {
            title: 'PlayStation 5 Slim Digital Edition',
            description: 'Sealed, region-free PS5 Slim with one DualSense controller.',
            price: 750_000,
            pricing: 'fixed',
            condition: 'new',
            stock: 3,
            categoryId: 'toys-games',
            delivery: 'nationwide',
            paymentMethod: 'escrow',
            images: [image],
            listedAs: 'official',
          },
          admin.token,
        ),
      );
      expect(created).toMatchObject({ status: 'active', listedAs: 'official', sellerName: 'DOOAA Official Store', sellerVerified: true });
      data(await http.patch(`/admin/listings/${created.id}/featured`, { featured: true }, admin.token));
      expect(data(await http.get('/products?collection=featured')).rows.map((row: any) => row.id)).toContain(created.id);
    });

    it('sends a console listing through review when published as pending, defaulting the condition to new', async () => {
      const admin = await staffToken(t, 'admin');
      const image = await uploadImage(t, admin.token, 'product', true);
      const input = {
        title: 'Nintendo Switch OLED',
        description: 'White Joy-Con, 64GB, sealed in the box.',
        price: 420_000,
        pricing: 'fixed',
        stock: 2,
        categoryId: 'toys-games',
        delivery: 'nationwide',
        paymentMethod: 'default',
        highlights: '7-inch OLED screen\n64GB storage',
        status: 'pending',
      };
      failure(await http.post('/admin/listings', input, admin.token), 400, 'IMAGES_REQUIRED');

      const created = data(await http.post('/admin/listings', { ...input, images: [image] }, admin.token));
      expect(created).toMatchObject({ status: 'pending', highlights: ['7-inch OLED screen', '64GB storage'] });
      failure(await http.get(`/products/${created.id}`), 404);

      const approved = data(await http.patch(`/admin/listings/${created.id}/status`, { status: 'active' }, admin.token));
      expect(approved.status).toBe('active');
      expect(data(await http.get(`/products/${created.id}`))).toMatchObject({ title: 'Nintendo Switch OLED', condition: 'new' });

      failure(await http.post('/admin/listings', { ...input, images: [image], status: 'rejected' }, admin.token), 400, 'VALIDATION_FAILED');
    });

    it('lists every category for the console, including closed ones', async () => {
      const admin = await staffToken(t, 'superadmin');
      expect(data(await http.get('/admin/categories', admin.token))).toHaveLength(12);
      expect(data(await http.patch('/admin/categories/books', { description: 'Novels, textbooks & many more' }, admin.token)).description).toBe('Novels, textbooks & many more');
    });
  });
});
