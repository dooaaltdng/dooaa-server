import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import { BLOG_CATEGORY_LABEL, type BlogCategory, type BlogState } from '../../common/domain';
import { DAY } from '../../common/util/dates';
import { InjectDb, type Database, type Where } from '../../database/database';
import { blogArticles, blogComments, blogLikes, blogViews, type BlogArticleRow, type BlogViewRow } from '../../database/schema';
import { TRAFFIC_LABEL, type TrafficSource } from '../analytics/traffic';
import { INTERNAL_SOURCE } from './blog-audience.service';
import { BlogService, stateOf, type AdminArticleSummary } from './blog.service';

export type BlogRange = '7d' | '30d' | '90d' | '12m';

const RANGE_DAYS: Record<BlogRange, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

/** A figure with its change against the period before (null when there was nothing to compare with). */
export type Delta = { value: number; previous: number; change: number | null };

export type BlogOverview = {
  range: BlogRange;
  category: BlogCategory | null;
  totals: { views: Delta; visitors: Delta; engagement: Delta };
  regions: { name: string; visits: number }[];
  /** Reads with a known place, out of all reads in the range. */
  located: number;
  sources: { id: string; label: string; visits: number; share: number }[];
  impressions: {
    total: number;
    /** Share of timed reads that left within 15 seconds without reaching the end; null until reads report. */
    bounceRate: number | null;
    /** Average seconds on the page across timed reads. */
    averageSeconds: number | null;
    /** Share of timed reads that reached the end. */
    readThrough: number | null;
  };
  top: (Pick<AdminArticleSummary, 'id' | 'slug' | 'title' | 'coverUrl' | 'publishedAt' | 'state' | 'likes' | 'comments'> & { views: number })[];
  recent: AdminArticleSummary[];
  counts: { published: number; scheduled: number; drafts: number; trash: number };
};

export type CalendarEntry = { id: string; title: string; slug: string; state: BlogState; publishedAt: string; author: string; coverUrl: string | null };

const BOUNCE_SECONDS = 15;

function delta(value: number, previous: number): Delta {
  const change = previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : null;
  return { value, previous, change };
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** The numbers on the console's blog dashboard. */
@Injectable()
export class BlogStatsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly blog: BlogService,
  ) {}

  private async articleIds(category: BlogCategory | null): Promise<string[] | null> {
    if (!category) return null;
    return this.db.distinct(blogArticles, 'id', { category });
  }

  private viewWhere(from: Date, to: Date, ids: string[] | null): Where<BlogViewRow> {
    return { createdAt: { $gte: from, $lt: to }, ...(ids ? { articleId: { $in: ids } } : {}) };
  }

  private async visitors(where: Where<BlogViewRow>): Promise<number> {
    const [row] = await this.db.aggregate<{ n: number }>(blogViews, [{ $match: where }, { $group: { _id: '$visitorId' } }, { $count: 'n' }]);
    return row?.n ?? 0;
  }

  private async interactions(from: Date, to: Date, ids: string[] | null): Promise<number> {
    const scope = ids ? { articleId: { $in: ids } } : {};
    const likes = await this.db.count(blogLikes, { createdAt: { $gte: from, $lt: to }, ...scope });
    const comments = await this.db.count(blogComments, { createdAt: { $gte: from, $lt: to }, userId: { $ne: null }, deletedAt: null, ...scope });
    return likes + comments;
  }

  async overview(range: BlogRange, category: BlogCategory | null): Promise<BlogOverview> {
    const now = new Date();
    const span = RANGE_DAYS[range] * DAY;
    const from = new Date(now.getTime() - span);
    const before = new Date(from.getTime() - span);
    const ids = await this.articleIds(category);
    const current = this.viewWhere(from, now, ids);
    const previous = this.viewWhere(before, from, ids);

    const [views, previousViews, visitors, previousVisitors, interactions, previousInteractions] = await Promise.all([
      this.db.count(blogViews, current),
      this.db.count(blogViews, previous),
      this.visitors(current),
      this.visitors(previous),
      this.interactions(from, now, ids),
      this.interactions(before, from, ids),
    ]);
    const engagement = Math.min(100, pct(interactions, views));
    const previousEngagement = Math.min(100, pct(previousInteractions, previousViews));

    const regionRows = await this.db.aggregate<{ _id: string; visits: number }>(blogViews, [
      { $match: { ...current, country: { $ne: null } } },
      { $group: { _id: { $ifNull: ['$region', '$country'] }, visits: { $sum: 1 } } },
      { $sort: { visits: -1, _id: 1 } },
      { $limit: 6 },
    ]);
    const located = await this.db.count(blogViews, { ...current, country: { $ne: null } });

    const sourceRows = await this.db.aggregate<{ _id: string; visits: number }>(blogViews, [
      { $match: current },
      { $group: { _id: '$source', visits: { $sum: 1 } } },
      { $sort: { visits: -1, _id: 1 } },
    ]);
    const label = (id: string) => (id === INTERNAL_SOURCE ? 'DOOAA' : (TRAFFIC_LABEL[id as TrafficSource] ?? id));
    const topSources = sourceRows.slice(0, 3);
    const rest = sourceRows.slice(3).reduce((sum, row) => sum + row.visits, 0);
    const sources = [
      ...topSources.map((row) => ({ id: row._id, label: label(row._id), visits: row.visits, share: pct(row.visits, views) })),
      ...(rest ? [{ id: 'rest', label: 'More sources', visits: rest, share: pct(rest, views) }] : []),
    ];

    const [timing] = await this.db.aggregate<{ timed: number; seconds: number; bounced: number; completed: number }>(blogViews, [
      { $match: { ...current, seconds: { $ne: null } } },
      {
        $group: {
          _id: null,
          timed: { $sum: 1 },
          seconds: { $sum: '$seconds' },
          bounced: { $sum: { $cond: [{ $and: [{ $lt: ['$seconds', BOUNCE_SECONDS] }, { $ne: ['$completed', true] }] }, 1, 0] } },
          completed: { $sum: { $cond: ['$completed', 1, 0] } },
        },
      },
    ]);
    const timed = timing?.timed ?? 0;

    return {
      range,
      category,
      totals: {
        views: delta(views, previousViews),
        visitors: delta(visitors, previousVisitors),
        engagement: delta(engagement, previousEngagement),
      },
      regions: regionRows.map((row) => ({ name: row._id, visits: row.visits })),
      located,
      sources,
      impressions: {
        total: views,
        bounceRate: timed ? pct(timing!.bounced, timed) : null,
        averageSeconds: timed ? Math.round(timing!.seconds / timed) : null,
        readThrough: timed ? pct(timing!.completed, timed) : null,
      },
      top: await this.top(current, ids),
      recent: await this.recent(category),
      counts: await this.counts(category),
    };
  }

  /** The four most read in the range; quiet ranges are topped up with the most read of all time. */
  private async top(where: Where<BlogViewRow>, ids: string[] | null): Promise<BlogOverview['top']> {
    const rows = await this.db.aggregate<{ _id: string; views: number }>(blogViews, [
      { $match: where },
      { $group: { _id: '$articleId', views: { $sum: 1 } } },
      { $sort: { views: -1, _id: 1 } },
      { $limit: 8 },
    ]);
    const counted = new Map(rows.map((row) => [row._id, row.views]));
    let articles = rows.length ? await this.db.find(blogArticles, { id: { $in: rows.map((row) => row._id) }, deletedAt: null }) : [];
    articles.sort((a, b) => (counted.get(b.id) ?? 0) - (counted.get(a.id) ?? 0));
    articles = articles.slice(0, 4);
    if (articles.length < 4) {
      const taken = articles.map((article) => article.id);
      const fill = await this.db.find(
        blogArticles,
        { status: 'published', deletedAt: null, id: ids ? { $in: ids, $nin: taken } : { $nin: taken } },
        { sort: { views: -1, publishedAt: -1 }, limit: 4 - articles.length },
      );
      articles = [...articles, ...fill];
    }
    const now = new Date();
    return articles.map((article) => ({
      id: article.id,
      slug: article.slug,
      title: article.title,
      coverUrl: article.coverUrl,
      publishedAt: article.publishedAt?.toISOString() ?? null,
      state: stateOf(article, now),
      likes: article.likes,
      comments: article.comments,
      views: counted.get(article.id) ?? 0,
    }));
  }

  private async recent(category: BlogCategory | null): Promise<AdminArticleSummary[]> {
    const rows = await this.db.find(blogArticles, { deletedAt: null, ...(category ? { category } : {}) }, { sort: { updatedAt: -1 }, limit: 2 });
    return this.blog.summaries(rows);
  }

  private async counts(category: BlogCategory | null): Promise<BlogOverview['counts']> {
    const now = new Date();
    const scope: Where<BlogArticleRow> = category ? { category } : {};
    const [published, scheduled, drafts, trash] = await Promise.all([
      this.db.count(blogArticles, { ...scope, deletedAt: null, status: 'published', publishedAt: { $lte: now } }),
      this.db.count(blogArticles, { ...scope, deletedAt: null, status: 'published', publishedAt: { $gt: now } }),
      this.db.count(blogArticles, { ...scope, deletedAt: null, status: 'draft' }),
      this.db.count(blogArticles, { ...scope, deletedAt: { $ne: null } }),
    ]);
    return { published, scheduled, drafts, trash };
  }

  /**
   * The dashboard's calendar: every article dated in a Lagos month — live,
   * scheduled, or a draft with a planned date — with a count per day.
   */
  async calendar(month: string): Promise<{ month: string; days: Record<string, number>; entries: CalendarEntry[] }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Errors.badRequest('Month must look like 2026-11.', 'INVALID_MONTH');
    const [year, number] = month.split('-').map(Number);
    const start = new Date(`${month}-01T00:00:00+01:00`);
    const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
    const end = new Date(`${next}-01T00:00:00+01:00`);
    const rows = await this.db.find(blogArticles, { deletedAt: null, publishedAt: { $gte: start, $lt: end } }, { sort: { publishedAt: 1 }, omit: ['body'] as never });
    const authors = await this.blog.authors(rows.map((row) => row.authorId));
    const now = new Date();
    const days: Record<string, number> = {};
    const entries = rows.map((row) => {
      const at = row.publishedAt!;
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(at);
      days[day] = (days[day] ?? 0) + 1;
      return {
        id: row.id,
        title: row.title || 'Untitled article',
        slug: row.slug,
        state: stateOf(row, now),
        publishedAt: at.toISOString(),
        author: authors.get(row.authorId)?.name ?? row.authorName,
        coverUrl: row.coverUrl,
      };
    });
    return { month, days, entries };
  }

  /** Category options with their labels, for the editor and the dashboard's filter. */
  categories(): { value: BlogCategory; label: string }[] {
    return (Object.keys(BLOG_CATEGORY_LABEL) as BlogCategory[]).map((value) => ({ value, label: BLOG_CATEGORY_LABEL[value] }));
  }
}
