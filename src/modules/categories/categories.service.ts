import { Injectable } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import { CacheService } from '../../cache/cache.service';
import { Errors } from '../../common/api/app-error';
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
    return this.cache.wrap(ALL_KEY, ALL_TTL_MS, () => this.db.select().from(categories).orderBy(asc(categories.order), asc(categories.name)));
  }

  /** Live listings per category slug. */
  private async productCounts(): Promise<Map<string, number>> {
    const rows = await this.cache.wrap(COUNTS_KEY, COUNTS_TTL_MS, () =>
      this.db.select({ slug: products.categoryId, count: count() }).from(products).where(PUBLIC_PRODUCT_FILTER).groupBy(products.categoryId),
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

  /** The landing rail's six tiles, in their drawn order and labels. */
  async homeTiles(): Promise<HomeTileView[]> {
    const active = (await this.all()).filter((category) => category.active);
    return active
      .flatMap((category) => category.home.map((tile) => ({ order: tile.order, id: category.slug, name: tile.label, image: tile.image || category.image })))
      .sort((a, b) => a.order - b.order)
      .map(({ id, name, image }) => ({ id, name, image }));
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

  async update(slug: string, patch: Partial<Pick<Category, 'name' | 'description' | 'image' | 'active' | 'order'>>): Promise<CategoryView> {
    const [updated] = await this.db.update(categories).set(patch).where(eq(categories.slug, slug)).returning();
    if (!updated) throw Errors.notFound('That category does not exist.', 'CATEGORY_NOT_FOUND');
    await this.invalidate();
    return this.view(updated, await this.productCounts());
  }

  /** Seeds the default taxonomy into an empty table. Safe to run on every boot; the console's edits are kept. */
  async ensureDefaults(): Promise<void> {
    const [{ total }] = await this.db.select({ total: count() }).from(categories);
    if (total > 0) return;
    await this.db
      .insert(categories)
      .values(DEFAULT_CATEGORIES.map((category, index) => ({ ...category, order: index + 1, active: true })))
      .onConflictDoNothing({ target: categories.slug });
    await this.invalidate();
  }

  async invalidate(): Promise<void> {
    await this.cache.delete(ALL_KEY, COUNTS_KEY);
  }

  async invalidateCounts(): Promise<void> {
    await this.cache.delete(COUNTS_KEY);
  }
}
