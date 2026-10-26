import { Injectable } from '@nestjs/common';
import { CacheService } from '../../cache/cache.service';
import { Errors } from '../../common/api/app-error';
import { slugify } from '../../common/util/text';
import { InjectDb, type Database } from '../../database/database';
import { categories, products } from '../../database/schema';
import { PUBLIC_PRODUCT_FILTER } from '../products/product.filters';
import { DEFAULT_CATEGORIES } from './category.seed';

export type Category = typeof categories.$inferSelect;

export type CategoryView = {
  id: string;
  slug: string;
  name: string;
  description: string;
  image: string;
  productCount: number;
  active: boolean;
};

export type HomeTileView = { id: string; name: string; image: string };

const ALL_KEY = 'categories:all';
const COUNTS_KEY = 'categories:counts';
const ALL_TTL_MS = 10 * 60_000;
const COUNTS_TTL_MS = 30_000;

@Injectable()
export class CategoriesService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly cache: CacheService,
  ) {}

  private all(): Promise<Category[]> {
    return this.cache.wrap(ALL_KEY, ALL_TTL_MS, async () =>
      (await this.db.find(categories, {})).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
    );
  }

  /** Live listings per category slug. */
  private async productCounts(): Promise<Map<string, number>> {
    const rows = await this.cache.wrap(COUNTS_KEY, COUNTS_TTL_MS, () =>
      this.db.aggregate<{ slug: string; count: number }>(products, [
        { $match: PUBLIC_PRODUCT_FILTER },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
        { $project: { _id: 0, slug: '$_id', count: 1 } },
      ]),
    );
    return new Map(rows.map((row) => [row.slug, row.count]));
  }

  private view(category: Category, counts: Map<string, number>): CategoryView {
    return {
      id: category.slug,
      slug: category.slug,
      name: category.name,
      description: category.description,
      image: category.image,
      productCount: counts.get(category.slug) ?? 0,
      active: category.active,
    };
  }

  async list(includeInactive = false): Promise<CategoryView[]> {
    const [all, counts] = await Promise.all([this.all(), this.productCounts()]);
    return all.filter((category) => includeInactive || category.active).map((category) => this.view(category, counts));
  }

  async get(slug: string): Promise<CategoryView> {
    const [all, counts] = await Promise.all([this.all(), this.productCounts()]);
    const category = all.find((entry) => entry.slug === slug && entry.active);
    if (!category) throw Errors.notFound('That category does not exist.', 'CATEGORY_NOT_FOUND');
    return this.view(category, counts);
  }

  /**
   * The landing page's "Browse Categories" rail: exactly the categories the
   * console manages — every visible one, A–Z, with the name and image set in
   * Items & Listing Management → Categories.
   */
  async homeTiles(): Promise<HomeTileView[]> {
    return (await this.all())
      .filter((category) => category.active)
      .map((category) => ({ id: category.slug, name: category.name, image: category.image }));
  }

  async nameOf(slug: string): Promise<string> {
    return (await this.all()).find((category) => category.slug === slug)?.name ?? slug;
  }

  async names(): Promise<Map<string, string>> {
    return new Map((await this.all()).map((category) => [category.slug, category.name]));
  }

  async exists(slug: string): Promise<boolean> {
    return (await this.all()).some((category) => category.slug === slug);
  }

  async assertKnown(slugs: string[]): Promise<void> {
    const known = new Set((await this.all()).map((category) => category.slug));
    const unknown = slugs.filter((slug) => !known.has(slug));
    if (unknown.length) throw Errors.badRequest(`Unknown categories: ${unknown.join(', ')}.`, 'UNKNOWN_CATEGORY');
  }

  /** The console's view: hidden categories too, in shop order, with every listing counted (not only live ones). */
  async adminList(): Promise<(CategoryView & { order: number; totalListings: number })[]> {
    const [all, counts, totals] = await Promise.all([
      this.all(),
      this.productCounts(),
      this.db.aggregate<{ slug: string; count: number }>(products, [
        { $match: { deletedAt: null } },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
        { $project: { _id: 0, slug: '$_id', count: 1 } },
      ]),
    ]);
    const total = new Map(totals.map((row) => [row.slug, row.count]));
    return all.map((category) => ({ ...this.view(category, counts), order: category.order, totalListings: total.get(category.slug) ?? 0 }));
  }

  /** A new category; categories are listed alphabetically. Its slug (the URL part) comes from the name and never changes. */
  async create(input: { name: string; description?: string; image?: string; active?: boolean }): Promise<CategoryView> {
    const base = slugify(input.name);
    if (!base) throw Errors.badRequest('Give the category a name with letters or numbers.', 'CATEGORY_NAME_INVALID');
    const all = await this.db.find(categories, {}, { sort: { order: -1 } });
    if (all.some((category) => category.name.trim().toLowerCase() === input.name.trim().toLowerCase())) {
      throw Errors.conflict(`A category called "${input.name.trim()}" already exists.`, 'CATEGORY_EXISTS');
    }
    let slug = base;
    for (let n = 2; all.some((category) => category.slug === slug); n += 1) slug = `${base}-${n}`;
    const created = await this.db.insert(categories, {
      slug,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      image: input.image ?? '',
      active: input.active ?? true,
      order: (all[0]?.order ?? 0) + 1,
      home: [],
    });
    await this.invalidate();
    return this.view(created, await this.productCounts());
  }

  /** Deletes a category nothing uses. One with listings must be hidden instead, so no listing is left without a category. */
  async remove(slug: string): Promise<{ slug: string; name: string }> {
    const category = await this.db.findOne(categories, { slug });
    if (!category) throw Errors.notFound('That category does not exist.', 'CATEGORY_NOT_FOUND');
    const used = await this.db.count(products, { categoryId: slug, deletedAt: null });
    if (used > 0) {
      throw Errors.conflict(
        `${category.name} still has ${used} listing${used === 1 ? '' : 's'}. Move them to another category first, or hide the category instead.`,
        'CATEGORY_IN_USE',
        { listings: used },
      );
    }
    await this.db.deleteMany(categories, { slug });
    await this.invalidate();
    return { slug, name: category.name };
  }

  async update(slug: string, patch: Partial<Pick<Category, 'name' | 'description' | 'image' | 'active' | 'order'>>): Promise<CategoryView> {
    const updated = await this.db.update(categories, { slug }, patch);
    if (!updated) throw Errors.notFound('That category does not exist.', 'CATEGORY_NOT_FOUND');
    await this.invalidate();
    return this.view(updated, await this.productCounts());
  }

  /** Seeds the default taxonomy into an empty table. Safe to run on every boot; the console's edits are kept. */
  async ensureDefaults(): Promise<void> {
    if ((await this.db.count(categories)) > 0) return;
    await this.db.insertIgnoringDuplicates(
      categories,
      DEFAULT_CATEGORIES.map((category, index) => ({ ...category, order: index + 1, active: true })),
    );
    await this.invalidate();
  }

  async invalidate(): Promise<void> {
    // 'catalog:home' (ProductsService) carries the landing rail, so a category edit refreshes it too.
    await this.cache.delete(ALL_KEY, COUNTS_KEY, 'catalog:home');
  }

  async invalidateCounts(): Promise<void> {
    await this.cache.delete(COUNTS_KEY);
  }
}
