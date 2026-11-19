import { BLOG_LINE_SPACING, BLOG_TEXT_SIZE, type BlogCategory, type BlogStatus, type BlogTheme } from '../../common/domain';
import { index, table } from '../database';

type Timestamps = { createdAt: Date; updatedAt: Date };

/**
 * A blog article, written in the console's editor and read on the storefront
 * at /blog/:slug. Counters are kept current by the modules that change
 * them, so the listing never has to count likes, comments or views.
 */
export type BlogArticleRow = Timestamps & {
  id: string;
  /** The route segment. Unique; a renamed article keeps answering on its old slugs. */
  slug: string;
  /** Set once someone edits the slug by hand; until then a draft's slug follows its title. */
  slugCustom: boolean;
  previousSlugs: string[];
  title: string;
  /** The line under the title on cards; written by the author or taken from the body. */
  excerpt: string;
  /** Sanitised rich text, exactly what the editor saves. */
  body: string;
  coverUrl: string | null;
  /** Describes the cover for people who can't see it. */
  coverAlt: string;
  category: BlogCategory;
  tags: string[];
  /** The tags as URL slugs, for /blog/tag/:slug. Kept in step with `tags` on every save. */
  tagSlugs: string[];
  /** Search-result title and description; blank uses the title and excerpt. */
  seoTitle: string;
  seoDescription: string;
  theme: BlogTheme;
  /** Body text size in px. */
  textSize: number;
  lineSpacing: number;
  /** Takes the large slot at the top of /blog. */
  featured: boolean;
  status: BlogStatus;
  /** When it goes (or went) live. A published article with a date ahead is scheduled. */
  publishedAt: Date | null;
  /** The staff member it is published under. */
  authorId: string;
  /** Kept in case the account is removed later. */
  authorName: string;
  wordCount: number;
  readMinutes: number;
  views: number;
  likes: number;
  comments: number;
  /** The first time it went live; a draft that was never published has none. */
  firstPublishedAt: Date | null;
  /** In the trash: off the storefront, restorable until deleted for good. */
  deletedAt: Date | null;
  updatedBy: string | null;
};

export const blogArticles = table<BlogArticleRow>()('blog_articles', {
  key: 'id',
  defaults: () => ({
    slugCustom: false,
    previousSlugs: [] as string[],
    excerpt: '',
    body: '',
    coverAlt: '',
    category: 'guides' as BlogCategory,
    tags: [] as string[],
    tagSlugs: [] as string[],
    seoTitle: '',
    seoDescription: '',
    theme: 'default' as BlogTheme,
    textSize: BLOG_TEXT_SIZE.default,
    lineSpacing: BLOG_LINE_SPACING.default,
    featured: false,
    status: 'draft' as BlogStatus,
    wordCount: 0,
    readMinutes: 1,
    views: 0,
    likes: 0,
    comments: 0,
  }),
  nullable: ['coverUrl', 'publishedAt', 'firstPublishedAt', 'deletedAt', 'updatedBy'],
  indexes: [
    index('blog_articles_slug_key', { slug: 1 }, { unique: true }),
    index('blog_articles_previous_slugs_idx', { previousSlugs: 1 }),
    index('blog_articles_live_idx', { status: 1, deletedAt: 1, publishedAt: -1 }),
    index('blog_articles_author_idx', { authorId: 1, updatedAt: -1 }),
    index('blog_articles_tags_idx', { tags: 1 }),
    index('blog_articles_tag_slugs_idx', { tagSlugs: 1 }),
  ],
});

/** One reader's like on one article. */
export type BlogLikeRow = { id: string; articleId: string; userId: string; createdAt: Date; updatedAt: Date };

export const blogLikes = table<BlogLikeRow>()('blog_likes', {
  key: 'id',
  indexes: [index('blog_likes_article_user_key', { articleId: 1, userId: 1 }, { unique: true }), index('blog_likes_created_idx', { createdAt: -1 })],
});

/**
 * A comment or a reply. Replies point at their parent and at the thread's
 * top-level comment (`rootId`), so a page of threads is two queries. A
 * deleted comment that still has replies keeps its place with its text gone.
 */
export type BlogCommentRow = Timestamps & {
  id: string;
  articleId: string;
  /** Exactly one of userId (a reader) and staffId (the DOOAA team, from the console) is set. */
  userId: string | null;
  staffId: string | null;
  /** Kept with the comment so threads read the same after an account closes. */
  authorName: string;
  parentId: string | null;
  rootId: string | null;
  depth: number;
  /** "@Ada" when this replies to someone in the deepest level, where replies stop nesting. */
  replyToName: string | null;
  /** Plain text. */
  body: string;
  likes: number;
  replies: number;
  editedAt: Date | null;
  deletedAt: Date | null;
  /** Who removed it: the writer themselves or a moderator. */
  deletedBy: 'author' | 'staff' | null;
};

export const blogComments = table<BlogCommentRow>()('blog_comments', {
  key: 'id',
  defaults: () => ({ depth: 0, likes: 0, replies: 0 }),
  nullable: ['userId', 'staffId', 'parentId', 'rootId', 'replyToName', 'editedAt', 'deletedAt', 'deletedBy'],
  indexes: [
    index('blog_comments_thread_idx', { articleId: 1, parentId: 1, createdAt: -1 }),
    index('blog_comments_root_idx', { rootId: 1, createdAt: 1 }),
    index('blog_comments_user_idx', { userId: 1, createdAt: -1 }),
    index('blog_comments_created_idx', { createdAt: -1 }),
  ],
});

export type BlogCommentLikeRow = { id: string; commentId: string; userId: string; createdAt: Date; updatedAt: Date };

export const blogCommentLikes = table<BlogCommentLikeRow>()('blog_comment_likes', {
  key: 'id',
  indexes: [index('blog_comment_likes_comment_user_key', { commentId: 1, userId: 1 }, { unique: true })],
});

/**
 * One read of one article: where it came from, roughly where in the world
 * (from the IP, which is not stored), and how long the reader stayed. A
 * reload within half an hour is the same read.
 */
export type BlogViewRow = Timestamps & {
  id: string;
  articleId: string;
  visitorId: string;
  userId: string | null;
  /** YYYY-MM-DD, Lagos. */
  day: string;
  /** See modules/analytics/traffic.ts. */
  source: string;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  /** Seconds on the page, from the read beacon; null until one arrives. */
  seconds: number | null;
  /** Scrolled to the end of the article. */
  completed: boolean;
};

export const blogViews = table<BlogViewRow>()('blog_views', {
  key: 'id',
  defaults: () => ({ completed: false }),
  nullable: ['userId', 'countryCode', 'country', 'region', 'city', 'seconds'],
  indexes: [
    index('blog_views_article_visitor_idx', { articleId: 1, visitorId: 1, createdAt: -1 }),
    index('blog_views_created_idx', { createdAt: -1 }),
  ],
});
