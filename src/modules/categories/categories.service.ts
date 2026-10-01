import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import { TtlCache } from '../../common/util/cache';
import type { Lean } from '../../common/util/mongo';
import { Product } from '../products/schemas/product.schema';
import { PUBLIC_PRODUCT_FILTER } from '../products/product.filters';
import { Category } from './category.schema';
import { DEFAULT_CATEGORIES } from './category.seed';

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

@Injectable()
export class CategoriesService {
  private readonly cache = new TtlCache<Lean<Category>[]>(60_000, 1);
  private readonly counts = new TtlCache<Map<string, number>>(30_000, 1);

  constructor(
    @InjectModel(Category.name) private readonly categories: Model<Category>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
  ) {}

  private all(): Promise<Lean<Category>[]> {
    return this.cache.wrap('all', () => this.categories.find().sort({ order: 1, name: 1 }).lean<Lean<Category>[]>());
  }

  private productCounts(): Promise<Map<string, number>> {
    return this.counts.wrap('counts', async () => {
      const rows = await this.products.aggregate<{ _id: string; count: number }>([
        { $match: PUBLIC_PRODUCT_FILTER },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
      ]);
      return new Map(rows.map((row) => [row._id, row.count]));
    });
  }

  private view(category: Lean<Category>, counts: Map<string, number>): CategoryView {
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
    const [categories, counts] = await Promise.all([this.all(), this.productCounts()]);
    return categories.filter((category) => includeInactive || category.active).map((category) => this.view(category, counts));
  }

  async get(slug: string): Promise<CategoryView> {
    const [categories, counts] = await Promise.all([this.all(), this.productCounts()]);
    const category = categories.find((entry) => entry.slug === slug && entry.active);
    if (!category) throw Errors.notFound('That category does not exist.', 'CATEGORY_NOT_FOUND');
    return this.view(category, counts);
  }

  /** The landing rail's six tiles, in their drawn order and labels. */
  async homeTiles(): Promise<HomeTileView[]> {
    const categories = (await this.all()).filter((category) => category.active);
    return categories
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
    const updated = await this.categories.findOneAndUpdate({ slug }, { $set: patch }, { returnDocument: 'after' }).lean<Lean<Category>>();
    if (!updated) throw Errors.notFound('That category does not exist.', 'CATEGORY_NOT_FOUND');
    this.invalidate();
    return this.view(updated, await this.productCounts());
  }

  /** Inserts the default taxonomy where it is missing. Safe to run on every boot. */
  async ensureDefaults(): Promise<void> {
    if ((await this.categories.estimatedDocumentCount()) > 0) return;
    await this.categories.bulkWrite(
      DEFAULT_CATEGORIES.map((category, index) => ({
        updateOne: { filter: { slug: category.slug }, update: { $setOnInsert: { ...category, order: index + 1, active: true } }, upsert: true },
      })),
    );
    this.invalidate();
  }

  invalidate(): void {
    this.cache.clear();
    this.counts.clear();
  }

  invalidateCounts(): void {
    this.counts.clear();
  }
}
