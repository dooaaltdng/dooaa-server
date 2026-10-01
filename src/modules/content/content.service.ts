import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import { dayKey } from '../../common/util/dates';
import type { Lean } from '../../common/util/mongo';
import { AuditService } from '../audit/audit.service';
import { ContentPage, ContentVersion } from './content.schema';
import { sanitizeContent } from './sanitize';
import { defaultPages } from './seed/pages';

export type ContentPageView = { id: string; slug: string; title: string; summary: string; updatedOn: string; updatedAt: string; body: string };
export type ContentVersionView = { id: string; savedAt: string; author: string; note: string; body: string; title: string };

/** The client's route segments for pages the console calls by shorter names. */
const ALIASES: Record<string, string> = {
  'refund-policy': 'refunds',
  'return-policy': 'refunds',
  'safety-tips': 'safety',
  'terms-and-conditions': 'terms',
  'privacy-policy': 'privacy',
  'about-us': 'about',
  faq: 'help',
  'help-center': 'help',
};

@Injectable()
export class ContentService {
  constructor(
    @InjectModel(ContentPage.name) private readonly pages: Model<ContentPage>,
    @InjectModel(ContentVersion.name) private readonly versions: Model<ContentVersion>,
    private readonly audit: AuditService,
  ) {}

  private resolve(slug: string): string {
    const key = slug.trim().toLowerCase();
    return ALIASES[key] ?? key;
  }

  private view(page: Lean<ContentPage>): ContentPageView {
    return {
      id: page.slug,
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      updatedOn: dayKey(page.updatedAt),
      updatedAt: new Date(page.updatedAt).toISOString(),
      body: page.body,
    };
  }

  private versionView(version: Lean<ContentVersion>): ContentVersionView {
    return {
      id: String(version._id),
      savedAt: new Date(version.createdAt).toISOString(),
      author: version.author,
      note: version.note,
      body: version.body,
      title: version.title,
    };
  }

  async list(): Promise<ContentPageView[]> {
    const rows = await this.pages.find().sort({ order: 1, title: 1 }).lean<Lean<ContentPage>[]>();
    return rows.map((row) => this.view(row));
  }

  async get(slug: string): Promise<ContentPageView> {
    const page = await this.pages.findOne({ slug: this.resolve(slug) }).lean<Lean<ContentPage>>();
    if (!page) throw Errors.notFound('That page is no longer published.', 'PAGE_NOT_FOUND');
    return this.view(page);
  }

  async history(slug: string): Promise<ContentVersionView[]> {
    const page = await this.get(slug);
    const rows = await this.versions.find({ slug: page.slug }).sort({ createdAt: -1 }).limit(50).lean<Lean<ContentVersion>[]>();
    return rows.map((row) => this.versionView(row));
  }

  /**
   * "Publish Changes": stores the sanitised body, records it as a version
   * and returns both, so the console can update the row, the preview and
   * the History tab from one response.
   */
  async publish(staff: AuthStaff, slug: string, input: { body: string; title?: string; summary?: string; note?: string }): Promise<{ page: ContentPageView; version: ContentVersionView }> {
    const current = await this.pages.findOne({ slug: this.resolve(slug) }).lean<Lean<ContentPage>>();
    if (!current) throw Errors.notFound('That page is no longer published.', 'PAGE_NOT_FOUND');
    const body = sanitizeContent(input.body);
    if (!body.replace(/<[^>]*>/g, '').trim()) throw Errors.badRequest('The page cannot be empty.', 'EMPTY_PAGE');
    const author = `${staff.firstName} ${staff.lastName}`;
    const page = await this.pages
      .findOneAndUpdate(
        { _id: current._id },
        { $set: { body, title: input.title?.trim() || current.title, summary: input.summary?.trim() ?? current.summary, updatedBy: author } },
        { returnDocument: 'after' },
      )
      .lean<Lean<ContentPage>>();
    const version = await this.versions.create({ slug: current.slug, title: page!.title, body, author, authorId: staff.id, note: input.note?.trim() || 'Published from the console.' });
    await this.audit.record(staff, { action: 'Published site content', target: page!.title, targetType: 'content', targetId: current.slug });
    return { page: this.view(page!), version: this.versionView(version.toObject() as Lean<ContentVersion>) };
  }

  /** Republishes an earlier version as the current page. */
  async restore(staff: AuthStaff, slug: string, versionId: string) {
    if (!Types.ObjectId.isValid(versionId)) throw Errors.notFound('That version no longer exists.', 'VERSION_NOT_FOUND');
    const version = await this.versions.findOne({ _id: versionId, slug: this.resolve(slug) }).lean<Lean<ContentVersion>>();
    if (!version) throw Errors.notFound('That version no longer exists.', 'VERSION_NOT_FOUND');
    return this.publish(staff, slug, { body: version.body, title: version.title, note: `Restored the version from ${dayKey(version.createdAt)}.` });
  }

  /** Inserts any default page that does not exist yet. Never overwrites published copy. */
  async ensureDefaults(): Promise<void> {
    const pages = defaultPages();
    await this.pages.bulkWrite(
      pages.map((page) => ({
        updateOne: {
          filter: { slug: page.slug },
          update: { $setOnInsert: { ...page, body: sanitizeContent(page.body), updatedBy: 'DOOAA' } },
          upsert: true,
        },
      })),
    );
  }
}
