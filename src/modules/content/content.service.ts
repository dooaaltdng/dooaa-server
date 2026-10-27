import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import { dayKey } from '../../common/util/dates';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, type Database } from '../../database/database';
import { contentPages, contentVersions } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { HOME_SLUG, homeHtml, parseHomeSections } from './home';
import { sanitizeContent } from './sanitize';
import { defaultPages } from './seed/pages';

export type ContentPageView = { id: string; slug: string; title: string; summary: string; updatedOn: string; updatedAt: string; body: string; sections: Record<string, unknown> | null };
export type ContentVersionView = { id: string; savedAt: string; author: string; note: string; body: string; title: string; sections: Record<string, unknown> | null };

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
      sections: page.sections ?? null,
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
      sections: version.sections ?? null,
    };
  }

  private async page(slug: string): Promise<ContentPage | null> {
    return this.db.findOne(contentPages, { slug: this.resolve(slug) });
  }

  async list(): Promise<ContentPageView[]> {
    const rows = await this.db.find(contentPages, {}, { sort: { order: 1, title: 1 } });
    // Home leads the list whatever order older databases stored the other pages under.
    rows.sort((a, b) => Number(b.slug === HOME_SLUG) - Number(a.slug === HOME_SLUG));
    return rows.map((row) => this.view(row));
  }

  async get(slug: string): Promise<ContentPageView> {
    const page = await this.page(slug);
    if (!page) throw Errors.notFound('That page is no longer published.', 'PAGE_NOT_FOUND');
    return this.view(page);
  }

  async history(slug: string): Promise<ContentVersionView[]> {
    const page = await this.get(slug);
    const rows = await this.db.find(contentVersions, { slug: page.slug }, { sort: { createdAt: -1 }, limit: 50 });
    return rows.map((row) => this.versionView(row));
  }

  /**
   * "Publish Changes": stores the sanitised body, records it as a version
   * and returns both, so the console can update the row, the preview and
   * the History tab from one response.
   *
   * The home page is published as `sections` (its fields); its body is
   * rendered from them rather than taken from the request.
   */
  async publish(staff: AuthStaff, slug: string, input: { body?: string; sections?: unknown; title?: string; summary?: string; note?: string }): Promise<{ page: ContentPageView; version: ContentVersionView }> {
    const current = await this.page(slug);
    if (!current) throw Errors.notFound('That page is no longer published.', 'PAGE_NOT_FOUND');
    let sections: Record<string, unknown> | null = null;
    let html = input.body ?? '';
    if (current.slug === HOME_SLUG) {
      if (input.sections === undefined) throw Errors.badRequest('The home page is published as sections.', 'INVALID_HOME_CONTENT');
      const parsed = parseHomeSections(input.sections);
      sections = parsed;
      html = homeHtml(parsed);
    }
    const body = sanitizeContent(html);
    if (!body.replace(/<[^>]*>/g, '').trim()) throw Errors.badRequest('The page cannot be empty.', 'EMPTY_PAGE');
    const author = `${staff.firstName} ${staff.lastName}`;
    const { page, version } = await this.db.transaction(async (tx) => {
      const updated = (await tx.update(
        contentPages,
        { id: current.id },
        { body, sections, title: input.title?.trim() || current.title, summary: input.summary?.trim() ?? current.summary, updatedBy: author },
      ))!;
      const saved = await tx.insert(contentVersions, {
        slug: current.slug,
        title: updated.title,
        body,
        sections,
        author,
        authorId: staff.id,
        note: input.note?.trim() || 'Published from the console.',
      });
      return { page: updated, version: saved };
    });
    await this.audit.record(staff, { action: 'Published site content', target: page.title, targetType: 'content', targetId: current.slug });
    return { page: this.view(page), version: this.versionView(version) };
  }

  /** Republishes an earlier version as the current page. */
  async restore(staff: AuthStaff, slug: string, versionId: string) {
    const version = isUuid(versionId) ? await this.db.findOne(contentVersions, { id: versionId, slug: this.resolve(slug) }) : null;
    if (!version) throw Errors.notFound('That version no longer exists.', 'VERSION_NOT_FOUND');
    return this.publish(staff, slug, { body: version.body, sections: version.sections ?? undefined, title: version.title, note: `Restored the version from ${dayKey(version.createdAt)}.` });
  }

  /** Inserts any default page that does not exist yet. Never overwrites published copy. */
  async ensureDefaults(): Promise<void> {
    await this.db.insertIgnoringDuplicates(
      contentPages,
      defaultPages().map((page) => ({ ...page, body: sanitizeContent(page.body), updatedBy: 'DOOAA' })),
    );
  }
}
