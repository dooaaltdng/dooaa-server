import { Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff } from '../../common/auth/principal';
import {
  BLOG_CATEGORIES,
  BLOG_CATEGORY_LABEL,
  BLOG_LINE_SPACING,
  BLOG_TEXT_SIZE,
  BLOG_THEMES,
  type BlogCategory,
  type BlogState,
  type BlogTheme,
} from '../../common/domain';
import { explain } from '../../common/util/explain-error';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, containsText, isUniqueViolation, type Database, type Where } from '../../database/database';
import { blogArticles, blogCommentLikes, blogComments, blogLikes, blogViews, staff, type BlogArticleRow } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { articleSlug, excerptFor, normalizeTags, readMinutes, sanitizeArticle, seoText, tagSlug, wordCount } from './blog-text';

export type BlogAuthor = { id: string; name: string; avatar: string | null; title: string | null };

/** A row in the console's lists and the dashboard's Recent Posts. */
export type AdminArticleSummary = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverUrl: string | null;
  coverAlt: string;
  category: BlogCategory;
  categoryLabel: string;
  tags: string[];
  featured: boolean;
  state: BlogState;
  publishedAt: string | null;
  author: BlogAuthor;
  readMinutes: number;
  wordCount: number;
  views: number;
  likes: number;
  comments: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** The storefront path. */
  path: string;
};

/** Everything the editor needs. */
export type AdminArticle = AdminArticleSummary & {
  body: string;
  seoTitle: string;
  seoDescription: string;
  /** What the author wrote; `excerpt` falls back to the body's opening. */
  writtenExcerpt: string;
  slugCustom: boolean;
  theme: BlogTheme;
  textSize: number;
  lineSpacing: number;
  firstPublishedAt: string | null;
};

/** A card on /blog. */
export type PublicArticleCard = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverUrl: string | null;
  category: BlogCategory;
  categoryLabel: string;
  tags: string[];
  /** The tags with their /blog/tag/:slug slugs, in the same order. */
  tagLinks: { tag: string; slug: string }[];
  featured: boolean;
  publishedAt: string;
  updatedAt: string;
  author: { name: string; avatar: string | null };
  readMinutes: number;
  likes: number;
  comments: number;
};

export type PublicArticle = PublicArticleCard & {
  body: string;
  coverAlt: string;
  wordCount: number;
  /** What search results show; the title and excerpt when the writer left them blank. */
  seoTitle: string;
  seoDescription: string;
  theme: BlogTheme;
  textSize: number;
  lineSpacing: number;
  /** True when the slug asked for is an old one; the storefront redirects to `slug`. */
  moved: boolean;
  liked: boolean;
  related: PublicArticleCard[];
};

export type ArticleInput = {
  title?: string;
  body?: string;
  excerpt?: string;
  coverUrl?: string | null;
  coverAlt?: string;
  category?: BlogCategory;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  theme?: BlogTheme;
  textSize?: number;
  lineSpacing?: number;
  featured?: boolean;
  slug?: string;
  authorId?: string;
  publishedAt?: string | null;
};

export type AdminListQuery = {
  status?: 'all' | BlogState | 'trash';
  q?: string;
  mine?: boolean;
  category?: BlogCategory;
  page?: number;
  limit?: number;
};

export type AdminListCounts = Record<'all' | BlogState | 'trash', number>;

type ArticleRow = BlogArticleRow;

const NOT_FOUND = () => Errors.notFound('That article no longer exists.', 'ARTICLE_NOT_FOUND');

/** Published, out of the trash and already due. */
export function liveWhere(now = new Date()): Where<ArticleRow> {
  return { status: 'published', deletedAt: null, publishedAt: { $lte: now } };
}

export function stateOf(row: Pick<ArticleRow, 'status' | 'publishedAt'>, now = new Date()): BlogState {
  if (row.status !== 'published') return 'draft';
  return row.publishedAt && row.publishedAt > now ? 'scheduled' : 'published';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The blog's articles: written and published from the console, read on the
 * storefront. Likes, comments and views live in their own services; this one
 * owns the article itself and how it is shown.
 */
@Injectable()
export class BlogService {
  private readonly logger = new Logger(BlogService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /* --- Presentation ------------------------------------------------------ */

  /** Live author details (name and photo can change); the stored name covers removed accounts. */
  async authors(ids: string[]): Promise<Map<string, BlogAuthor>> {
    const unique = [...new Set(ids)].filter(isUuid);
    const rows = unique.length ? await this.db.find(staff, { id: { $in: unique } }) : [];
    return new Map(
      rows.map((row) => [row.id, { id: row.id, name: `${row.firstName} ${row.lastName}`.trim(), avatar: row.avatarUrl, title: row.title }]),
    );
  }

  private author(row: ArticleRow, authors: Map<string, BlogAuthor>): BlogAuthor {
    return authors.get(row.authorId) ?? { id: row.authorId, name: row.authorName, avatar: null, title: null };
  }

  private summary(row: ArticleRow, authors: Map<string, BlogAuthor>, now = new Date()): AdminArticleSummary {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: excerptFor(row.body, row.excerpt),
      coverUrl: row.coverUrl,
      coverAlt: row.coverAlt ?? '',
      category: row.category,
      categoryLabel: BLOG_CATEGORY_LABEL[row.category] ?? row.category,
      tags: row.tags,
      featured: row.featured,
      state: stateOf(row, now),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      author: this.author(row, authors),
      readMinutes: row.readMinutes,
      wordCount: row.wordCount,
      views: row.views,
      likes: row.likes,
      comments: row.comments,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
      path: `/blog/${row.slug}`,
    };
  }

  private full(row: ArticleRow, authors: Map<string, BlogAuthor>): AdminArticle {
    return {
      ...this.summary(row, authors),
      body: row.body,
      seoTitle: row.seoTitle ?? '',
      seoDescription: row.seoDescription ?? '',
      writtenExcerpt: row.excerpt,
      slugCustom: row.slugCustom,
      theme: row.theme,
      textSize: row.textSize,
      lineSpacing: row.lineSpacing,
      firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
    };
  }

  card(row: ArticleRow, authors: Map<string, BlogAuthor>): PublicArticleCard {
    const author = this.author(row, authors);
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: excerptFor(row.body, row.excerpt),
      coverUrl: row.coverUrl,
      category: row.category,
      categoryLabel: BLOG_CATEGORY_LABEL[row.category] ?? row.category,
      tags: row.tags,
      tagLinks: row.tags.map((tag) => ({ tag, slug: tagSlug(tag) })),
      featured: row.featured,
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      author: { name: author.name, avatar: author.avatar },
      readMinutes: row.readMinutes,
      likes: row.likes,
      comments: row.comments,
    };
  }

  async summaries(rows: ArticleRow[]): Promise<AdminArticleSummary[]> {
    const authors = await this.authors(rows.map((row) => row.authorId));
    const now = new Date();
    return rows.map((row) => this.summary(row, authors, now));
  }

  async cards(rows: ArticleRow[]): Promise<PublicArticleCard[]> {
    const authors = await this.authors(rows.map((row) => row.authorId));
    return rows.map((row) => this.card(row, authors));
  }

  /* --- Lookups ----------------------------------------------------------- */

  async row(id: string): Promise<ArticleRow> {
    const row = isUuid(id) ? await this.db.findOne(blogArticles, { id }) : null;
    if (!row) throw NOT_FOUND();
    return row;
  }

  /** A live article by its slug or one of its old slugs. */
  async liveBySlug(slug: string): Promise<{ row: ArticleRow; moved: boolean }> {
    const key = slug.trim().toLowerCase();
    const live = liveWhere();
    const row = (await this.db.findOne(blogArticles, { ...live, slug: key })) ?? (await this.db.findOne(blogArticles, { ...live, previousSlugs: key }));
    if (!row) throw NOT_FOUND();
    return { row, moved: row.slug !== key };
  }

  /** A slug no other article uses now or used before. */
  private async uniqueSlug(base: string, exceptId?: string): Promise<string> {
    for (let attempt = 1; attempt < 500; attempt += 1) {
      const candidate = attempt === 1 ? base : `${base.slice(0, 76)}-${attempt}`;
      const clash = await this.db.findOne(blogArticles, {
        $or: [{ slug: candidate }, { previousSlugs: candidate }],
        ...(exceptId ? { id: { $ne: exceptId } } : {}),
      });
      if (!clash) return candidate;
    }
    return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
  }

  /** The staff member an article may be published under: active, and allowed to write. */
  private async authorFor(id: string): Promise<{ id: string; name: string }> {
    const member = isUuid(id) ? await this.db.findOne(staff, { id, status: 'active' }) : null;
    if (!member || !(await this.settings.can(member.role, 'blog.write'))) {
      throw Errors.badRequest('Choose a team member who can write for the blog.', 'INVALID_AUTHOR');
    }
    return { id: member.id, name: `${member.firstName} ${member.lastName}`.trim() };
  }

  /** Team members who can be named as an article's author. */
  async authorOptions(): Promise<BlogAuthor[]> {
    const members = await this.db.find(staff, { status: 'active' }, { sort: { firstName: 1, lastName: 1 } });
    const allowed: BlogAuthor[] = [];
    for (const member of members) {
      if (await this.settings.can(member.role, 'blog.write')) {
        allowed.push({ id: member.id, name: `${member.firstName} ${member.lastName}`.trim(), avatar: member.avatarUrl, title: member.title });
      }
    }
    return allowed;
  }

  /* --- Console ----------------------------------------------------------- */

  private listWhere(query: AdminListQuery, staffId: string, now: Date, status = query.status ?? 'all'): Where<ArticleRow> {
    const where: Where<ArticleRow> = status === 'trash' ? { deletedAt: { $ne: null } } : { deletedAt: null };
    if (status === 'draft') where.status = 'draft';
    if (status === 'published') Object.assign(where, { status: 'published', publishedAt: { $lte: now } });
    if (status === 'scheduled') Object.assign(where, { status: 'published', publishedAt: { $gt: now } });
    if (query.mine) where.authorId = staffId;
    if (query.category) where.category = query.category;
    if (query.q?.trim()) where.title = containsText(query.q);
    return where;
  }

  async list(actor: AuthStaff, query: AdminListQuery): Promise<Page<AdminArticleSummary> & { counts: AdminListCounts }> {
    const now = new Date();
    const where = this.listWhere(query, actor.id, now);
    const total = await this.db.count(blogArticles, where);
    const window = pageWindow(total, query.page, query.limit ?? 10);
    const sort = query.status === 'trash' ? { deletedAt: -1 as const } : query.status === 'draft' ? { updatedAt: -1 as const } : { publishedAt: -1 as const, updatedAt: -1 as const };
    const rows = await this.db.find(blogArticles, where, { sort, skip: window.skip, limit: window.size });
    const counts = {} as AdminListCounts;
    for (const tab of ['all', 'draft', 'scheduled', 'published', 'trash'] as const) {
      counts[tab] = await this.db.count(blogArticles, this.listWhere({ ...query, status: tab }, actor.id, now, tab));
    }
    return { ...toPage(await this.summaries(rows), total, window), counts };
  }

  async get(id: string): Promise<AdminArticle> {
    const row = await this.row(id);
    return this.full(row, await this.authors([row.authorId]));
  }

  /** A new draft under the writer's name. Everything is optional: the editor saves as soon as there is something to keep. */
  async create(actor: AuthStaff, input: ArticleInput): Promise<AdminArticle> {
    const author = input.authorId ? await this.authorFor(input.authorId) : { id: actor.id, name: `${actor.firstName} ${actor.lastName}`.trim() };
    const fields = await this.fields(input, null);
    const title = fields.title ?? '';
    const custom = input.slug !== undefined && articleSlug(input.slug) !== 'article';
    for (let attempt = 0; ; attempt += 1) {
      const slug = await this.uniqueSlug(custom ? articleSlug(input.slug!) : articleSlug(title || 'untitled'));
      try {
        const row = await this.db.insert(blogArticles, {
          ...fields,
          title,
          slug,
          slugCustom: custom,
          authorId: author.id,
          authorName: author.name,
          updatedBy: `${actor.firstName} ${actor.lastName}`.trim(),
        });
        return this.full(row, await this.authors([row.authorId]));
      } catch (error) {
        // Two drafts claimed the same slug at once: pick again.
        if (!isUniqueViolation(error, 'blog_articles_slug_key') || attempt > 3) throw error;
      }
    }
  }

  /** Validates and normalises an edit; returns only the fields it changes. */
  private async fields(input: ArticleInput, current: ArticleRow | null): Promise<Partial<ArticleRow>> {
    const patch: Partial<ArticleRow> = {};
    if (input.title !== undefined) patch.title = input.title.replace(/\s+/g, ' ').trim();
    if (input.body !== undefined) {
      patch.body = sanitizeArticle(input.body);
      patch.wordCount = wordCount(patch.body);
      patch.readMinutes = readMinutes(patch.body);
    }
    if (input.excerpt !== undefined) patch.excerpt = input.excerpt.replace(/\s+/g, ' ').trim();
    if (input.coverAlt !== undefined) patch.coverAlt = input.coverAlt.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (input.coverUrl !== undefined) {
      if (input.coverUrl !== null && !/^https?:\/\/\S+$/i.test(input.coverUrl)) throw Errors.badRequest('The cover must be an uploaded image.', 'INVALID_COVER');
      patch.coverUrl = input.coverUrl;
    }
    if (input.category !== undefined) {
      if (!BLOG_CATEGORIES.includes(input.category)) throw Errors.badRequest('Choose one of the blog categories.', 'INVALID_CATEGORY');
      patch.category = input.category;
    }
    if (input.tags !== undefined) {
      patch.tags = normalizeTags(input.tags);
      patch.tagSlugs = [...new Set(patch.tags.map(tagSlug).filter(Boolean))];
    }
    if (input.seoTitle !== undefined) patch.seoTitle = seoText(input.seoTitle, 70);
    if (input.seoDescription !== undefined) patch.seoDescription = seoText(input.seoDescription, 170);
    if (input.theme !== undefined) {
      if (!BLOG_THEMES.includes(input.theme)) throw Errors.badRequest('Choose one of the theme styles.', 'INVALID_THEME');
      patch.theme = input.theme;
    }
    if (input.textSize !== undefined) patch.textSize = Math.round(clamp(input.textSize, BLOG_TEXT_SIZE.min, BLOG_TEXT_SIZE.max));
    if (input.lineSpacing !== undefined) patch.lineSpacing = Math.round(clamp(input.lineSpacing, BLOG_LINE_SPACING.min, BLOG_LINE_SPACING.max) * 20) / 20;
    if (input.featured !== undefined) patch.featured = input.featured;
    if (input.publishedAt !== undefined) {
      if (input.publishedAt === null) {
        if (current?.status === 'published') throw Errors.badRequest('A published article needs a date.', 'DATE_REQUIRED');
        patch.publishedAt = null;
      } else {
        const date = new Date(input.publishedAt);
        if (Number.isNaN(date.getTime())) throw Errors.badRequest('That date is not valid.', 'INVALID_DATE');
        patch.publishedAt = date;
      }
    }
    return patch;
  }

  /** Autosave and "Update": any of the editor's fields. */
  async update(actor: AuthStaff, id: string, input: ArticleInput): Promise<AdminArticle> {
    const current = await this.row(id);
    const patch = await this.fields(input, current);
    if (input.authorId !== undefined && input.authorId !== current.authorId) {
      const author = await this.authorFor(input.authorId);
      patch.authorId = author.id;
      patch.authorName = author.name;
    }

    // A draft's slug follows its title until someone sets one by hand; after publishing it only changes on purpose.
    const everPublished = current.status === 'published' || current.firstPublishedAt !== null;
    let nextSlug: string | null = null;
    if (input.slug !== undefined) {
      const wanted = articleSlug(input.slug);
      if (wanted !== current.slug) nextSlug = await this.uniqueSlug(wanted, current.id);
      patch.slugCustom = true;
    } else if (patch.title !== undefined && !current.slugCustom && !everPublished && patch.title) {
      const wanted = articleSlug(patch.title);
      if (wanted !== current.slug && !current.slug.startsWith(`${wanted}-`)) nextSlug = await this.uniqueSlug(wanted, current.id);
    }
    const update: Record<string, unknown> = { ...patch, updatedBy: `${actor.firstName} ${actor.lastName}`.trim() };
    if (nextSlug) {
      update.slug = nextSlug;
      if (everPublished) update.previousSlugs = [...new Set([...current.previousSlugs.filter((old) => old !== nextSlug), current.slug])].slice(-20);
      else update.previousSlugs = current.previousSlugs.filter((old) => old !== nextSlug);
    }
    try {
      const row = (await this.db.update(blogArticles, { id: current.id }, update as Partial<ArticleRow>))!;
      return this.full(row, await this.authors([row.authorId]));
    } catch (error) {
      if (isUniqueViolation(error, 'blog_articles_slug_key')) throw Errors.conflict('Another article already uses that link.', 'SLUG_TAKEN');
      throw error;
    }
  }

  /**
   * Puts an article live: now, at the date already on it, or at `publishAt`
   * (a date ahead schedules it).
   */
  async publish(actor: AuthStaff, id: string, input: { publishAt?: string | null }): Promise<AdminArticle> {
    const current = await this.row(id);
    if (current.deletedAt) throw Errors.conflict('Restore the article from the trash before publishing it.', 'ARTICLE_IN_TRASH');
    if (!current.title.trim()) throw Errors.badRequest('Give the article a title before publishing it.', 'TITLE_REQUIRED');
    if (current.wordCount < 1) throw Errors.badRequest('Write something before publishing the article.', 'BODY_REQUIRED');
    let publishedAt = current.publishedAt ?? new Date();
    if (input.publishAt) {
      publishedAt = new Date(input.publishAt);
      if (Number.isNaN(publishedAt.getTime())) throw Errors.badRequest('That date is not valid.', 'INVALID_DATE');
    } else if (input.publishAt === null) {
      publishedAt = new Date();
    }
    const row = (await this.db.update(
      blogArticles,
      { id: current.id },
      {
        status: 'published',
        publishedAt,
        firstPublishedAt: current.firstPublishedAt ?? publishedAt,
        updatedBy: `${actor.firstName} ${actor.lastName}`.trim(),
      },
    ))!;
    const scheduled = stateOf(row) === 'scheduled';
    await this.audit.record(actor, {
      action: scheduled ? 'Scheduled a blog article' : 'Published a blog article',
      target: row.title,
      targetType: 'blog-article',
      targetId: row.id,
    });
    return this.full(row, await this.authors([row.authorId]));
  }

  /** Back to draft: off the storefront, with its date kept for when it returns. */
  async unpublish(actor: AuthStaff, id: string): Promise<AdminArticle> {
    const current = await this.row(id);
    const row = (await this.db.update(blogArticles, { id: current.id }, { status: 'draft', updatedBy: `${actor.firstName} ${actor.lastName}`.trim() }))!;
    await this.audit.record(actor, { action: 'Unpublished a blog article', target: row.title, targetType: 'blog-article', targetId: row.id });
    return this.full(row, await this.authors([row.authorId]));
  }

  async trash(actor: AuthStaff, id: string): Promise<AdminArticle> {
    const current = await this.row(id);
    const row = (await this.db.update(blogArticles, { id: current.id }, { deletedAt: current.deletedAt ?? new Date() }))!;
    await this.audit.record(actor, { action: 'Moved a blog article to the trash', target: row.title || 'Untitled article', targetType: 'blog-article', targetId: row.id });
    return this.full(row, await this.authors([row.authorId]));
  }

  async restore(actor: AuthStaff, id: string): Promise<AdminArticle> {
    const current = await this.row(id);
    const row = (await this.db.update(blogArticles, { id: current.id }, { deletedAt: null }))!;
    await this.audit.record(actor, { action: 'Restored a blog article', target: row.title || 'Untitled article', targetType: 'blog-article', targetId: row.id });
    return this.full(row, await this.authors([row.authorId]));
  }

  /** Deletes an article in the trash for good, with its likes, comments and reading history. */
  async purge(actor: AuthStaff, id: string): Promise<{ id: string }> {
    const current = await this.row(id);
    if (!current.deletedAt) throw Errors.conflict('Move the article to the trash first.', 'ARTICLE_NOT_IN_TRASH');
    const commentIds = await this.db.distinct(blogComments, 'id', { articleId: current.id });
    await this.db.transaction(async (tx) => {
      await tx.delete(blogArticles, { id: current.id });
      await tx.deleteMany(blogLikes, { articleId: current.id });
      if (commentIds.length) await tx.deleteMany(blogCommentLikes, { commentId: { $in: commentIds } });
      await tx.deleteMany(blogComments, { articleId: current.id });
      await tx.deleteMany(blogViews, { articleId: current.id });
    });
    await this.audit.record(actor, { action: 'Deleted a blog article', target: current.title || 'Untitled article', targetType: 'blog-article', targetId: current.id }).catch((error) => {
      this.logger.warn(explain('Could not record the article deletion', error));
    });
    return { id: current.id };
  }

  /* --- Storefront -------------------------------------------------------- */

  /**
   * /blog: newest first. The first page also names the featured article
   * (the newest one marked featured, else the newest of all); `exclude`
   * keeps it out of the grid on every page.
   */
  async listPublic(query: { page?: number; limit?: number; offset?: number; q?: string; tag?: string; category?: BlogCategory; exclude?: string; withFeatured?: boolean }) {
    const where: Where<ArticleRow> = liveWhere();
    // The search box on /blog: titles, excerpts, tags and the articles' own words.
    if (query.q?.trim()) {
      const term = containsText(query.q.slice(0, 80));
      where.$or = [{ title: term }, { excerpt: term }, { tags: term }, { body: term }];
    }
    // /blog/tag/:slug — tags are matched by their slug.
    const tag = query.tag?.trim() ? tagSlug(query.tag) : null;
    if (tag) where.tagSlugs = tag;
    if (query.category) where.category = query.category;
    let featured: ArticleRow | null = null;
    if (query.withFeatured) {
      featured =
        (await this.db.findOne(blogArticles, { ...where, featured: true }, { sort: { publishedAt: -1 } })) ??
        (await this.db.findOne(blogArticles, where, { sort: { publishedAt: -1 } }));
    }
    const excluded = featured?.id ?? (query.exclude && isUuid(query.exclude) ? query.exclude : null);
    if (excluded) where.id = { $ne: excluded };
    const total = await this.db.count(blogArticles, where);
    const size = query.limit ?? 6;
    // "Load More" asks by offset, so a first screen of four can be followed by rows of three.
    const window = query.offset !== undefined ? { page: Math.floor(query.offset / size) + 1, size, skip: query.offset, pageCount: Math.max(1, Math.ceil(total / size)) } : pageWindow(total, query.page, size);
    const rows = await this.db.find(blogArticles, where, { sort: { publishedAt: -1, id: -1 }, skip: window.skip, limit: window.size });
    const cards = await this.cards(featured ? [featured, ...rows] : rows);
    const page = toPage(featured ? cards.slice(1) : cards, total, window);
    // The tag as writers spelled it, for the landing page's heading.
    const tagName = tag ? ([featured, ...rows].flatMap((row) => row?.tags ?? []).find((name) => tagSlug(name) === tag) ?? null) : null;
    return { ...page, hasMore: window.skip + rows.length < total, featured: featured ? cards[0] : null, tag: tagName };
  }

  /** Every live article with its date and cover, for the storefront's sitemap and feed. */
  async sitemap(): Promise<{ slug: string; title: string; updatedAt: string; publishedAt: string; coverUrl: string | null }[]> {
    const rows = await this.db.find(blogArticles, liveWhere(), { sort: { publishedAt: -1 }, limit: 5000, omit: ['body'] as never });
    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
      coverUrl: row.coverUrl,
    }));
  }

  /** The tags on live articles, most used first, with their slugs. Spellings that share a slug count together. */
  async tags(): Promise<{ tag: string; slug: string; count: number }[]> {
    const rows = await this.db.aggregate<{ _id: string; count: number }>(blogArticles, [
      { $match: { status: 'published', deletedAt: null, publishedAt: { $lte: new Date() } } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]);
    const bySlug = new Map<string, { tag: string; slug: string; count: number }>();
    for (const row of rows) {
      const slug = tagSlug(row._id);
      if (!slug) continue;
      const known = bySlug.get(slug);
      if (known) known.count += row.count;
      else bySlug.set(slug, { tag: row._id, slug, count: row.count });
    }
    return [...bySlug.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, 100);
  }

  /** Every category with how many live articles it has, for /blog/category/:slug and the sitemap. */
  async categories(): Promise<{ value: BlogCategory; label: string; count: number }[]> {
    const rows = await this.db.aggregate<{ _id: BlogCategory; count: number }>(blogArticles, [
      { $match: { status: 'published', deletedAt: null, publishedAt: { $lte: new Date() } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const counts = new Map(rows.map((row) => [row._id, row.count]));
    return BLOG_CATEGORIES.map((value) => ({ value, label: BLOG_CATEGORY_LABEL[value], count: counts.get(value) ?? 0 }));
  }

  /** Articles saved before tag slugs existed get theirs, once, at startup. */
  async backfillTagSlugs(): Promise<number> {
    const rows = await this.db.find(blogArticles, { tagSlugs: { $exists: false } } as Where<ArticleRow>, { omit: ['body'] as never, limit: 5000 });
    for (const row of rows) await this.db.collection(blogArticles).updateOne({ _id: row.id } as never, { $set: { tagSlugs: [...new Set(row.tags.map(tagSlug).filter(Boolean))] } });
    return rows.length;
  }

  /** Up to three other live articles: the same category first, then the newest. */
  async related(row: ArticleRow): Promise<PublicArticleCard[]> {
    const live = liveWhere();
    const same = await this.db.find(blogArticles, { ...live, id: { $ne: row.id }, category: row.category }, { sort: { publishedAt: -1 }, limit: 3 });
    const others =
      same.length < 3
        ? await this.db.find(blogArticles, { ...live, id: { $nin: [row.id, ...same.map((item) => item.id)] } }, { sort: { publishedAt: -1 }, limit: 3 - same.length })
        : [];
    return this.cards([...same, ...others]);
  }

  async getPublic(slug: string, liked: (articleId: string) => Promise<boolean>): Promise<PublicArticle> {
    const { row, moved } = await this.liveBySlug(slug);
    const authors = await this.authors([row.authorId]);
    return {
      ...this.card(row, authors),
      body: row.body,
      coverAlt: row.coverAlt ?? '',
      wordCount: row.wordCount,
      seoTitle: row.seoTitle || row.title,
      seoDescription: row.seoDescription || excerptFor(row.body, row.excerpt).slice(0, 160),
      theme: row.theme,
      textSize: row.textSize,
      lineSpacing: row.lineSpacing,
      moved,
      liked: await liked(row.id),
      related: await this.related(row),
    };
  }
}
