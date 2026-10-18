import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import { dayKey } from '../../common/util/dates';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { contentPages, contentVersions } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { sanitizeContent } from './sanitize';
import { defaultPages } from './seed/pages';

export type ContentPageView = { id: string; slug: string; title: string; summary: string; updatedOn: string; updatedAt: string; body: string };
export type ContentVersionView = { id: string; savedAt: string; author: string; note: string; body: string; title: string };

type ContentPage = typeof contentPages.$inferSelect;
type ContentVersion = typeof contentVersions.$inferSelect;

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
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private resolve(slug: string): string {
    const key = slug.trim().toLowerCase();
    return ALIASES[key] ?? key;
  }

  private view(page: ContentPage): ContentPageView {
    return {
      id: page.slug,
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      updatedOn: dayKey(page.updatedAt),
      updatedAt: page.updatedAt.toISOString(),
      body: page.body,
    };
  }

  private versionView(version: ContentVersion): ContentVersionView {
    return {
      id: version.id,
      savedAt: version.createdAt.toISOString(),
      author: version.author,
      note: version.note,
      body: version.body,
      title: version.title,
    };
  }

  private async page(slug: string): Promise<ContentPage | null> {
    const [page] = await this.db.select().from(contentPages).where(eq(contentPages.slug, this.resolve(slug)));
    return page ?? null;
  }

  async list(): Promise<ContentPageView[]> {
    const rows = await this.db.select().from(contentPages).orderBy(asc(contentPages.order), asc(contentPages.title));
    return rows.map((row) => this.view(row));
  }

  async get(slug: string): Promise<ContentPageView> {
    const page = await this.page(slug);
    if (!page) throw Errors.notFound('That page is no longer published.', 'PAGE_NOT_FOUND');
    return this.view(page);
  }

  async history(slug: string): Promise<ContentVersionView[]> {
    const page = await this.get(slug);
    const rows = await this.db.select().from(contentVersions).where(eq(contentVersions.slug, page.slug)).orderBy(desc(contentVersions.createdAt)).limit(50);
    return rows.map((row) => this.versionView(row));
  }

  /**
   * "Publish Changes": stores the sanitised body, records it as a version
   * and returns both, so the console can update the row, the preview and
   * the History tab from one response.
   */
  async publish(staff: AuthStaff, slug: string, input: { body: string; title?: string; summary?: string; note?: string }): Promise<{ page: ContentPageView; version: ContentVersionView }> {
    const current = await this.page(slug);
    if (!current) throw Errors.notFound('That page is no longer published.', 'PAGE_NOT_FOUND');
    const body = sanitizeContent(input.body);
    if (!body.replace(/<[^>]*>/g, '').trim()) throw Errors.badRequest('The page cannot be empty.', 'EMPTY_PAGE');
    const author = `${staff.firstName} ${staff.lastName}`;
    const { page, version } = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(contentPages)
        .set({ body, title: input.title?.trim() || current.title, summary: input.summary?.trim() ?? current.summary, updatedBy: author })
        .where(eq(contentPages.id, current.id))
        .returning();
      const [saved] = await tx
        .insert(contentVersions)
        .values({ slug: current.slug, title: updated.title, body, author, authorId: staff.id, note: input.note?.trim() || 'Published from the console.' })
        .returning();
      return { page: updated, version: saved };
    });
    await this.audit.record(staff, { action: 'Published site content', target: page.title, targetType: 'content', targetId: current.slug });
    return { page: this.view(page), version: this.versionView(version) };
  }

  /** Republishes an earlier version as the current page. */
  async restore(staff: AuthStaff, slug: string, versionId: string) {
    const [version] = isUuid(versionId)
      ? await this.db
          .select()
          .from(contentVersions)
          .where(and(eq(contentVersions.id, versionId), eq(contentVersions.slug, this.resolve(slug))))
      : [];
    if (!version) throw Errors.notFound('That version no longer exists.', 'VERSION_NOT_FOUND');
    return this.publish(staff, slug, { body: version.body, title: version.title, note: `Restored the version from ${dayKey(version.createdAt)}.` });
  }

  /** Inserts any default page that does not exist yet. Never overwrites published copy. */
  async ensureDefaults(): Promise<void> {
    await this.db
      .insert(contentPages)
      .values(defaultPages().map((page) => ({ ...page, body: sanitizeContent(page.body), updatedBy: 'DOOAA' })))
      .onConflictDoNothing({ target: contentPages.slug });
  }
}
