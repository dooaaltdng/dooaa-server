import { Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../common/api/app-error';
import type { AuthStaff, AuthUser } from '../../common/auth/principal';
import { BLOG_MAX_COMMENT_DEPTH } from '../../common/domain';
import { explain } from '../../common/util/explain-error';
import { pageWindow, toPage, type Page } from '../../common/util/pagination';
import { excerpt } from '../../common/util/text';
import { isUuid } from '../../common/util/uuid';
import { InjectDb, isUniqueViolation, type Database, type Where } from '../../database/database';
import { blogArticles, blogCommentLikes, blogComments, blogLikes, staff, users, type BlogArticleRow, type BlogCommentRow } from '../../database/schema';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BlogService } from './blog.service';

export type CommentSort = 'newest' | 'oldest' | 'top';

export type CommentAuthor = {
  name: string;
  avatar: string | null;
  kind: 'user' | 'staff';
  /** "Author" for the article's writer, "DOOAA Team" for other staff. */
  badge: string | null;
};

export type CommentView = {
  id: string;
  parentId: string | null;
  rootId: string | null;
  depth: number;
  /** Empty once deleted. */
  body: string;
  deleted: boolean;
  author: CommentAuthor;
  replyTo: string | null;
  likes: number;
  liked: boolean;
  replies: number;
  mine: boolean;
  edited: boolean;
  createdAt: string;
  children: CommentView[];
};

export type CommentPage = Page<CommentView> & { count: number };

type CommentRow = BlogCommentRow;

/** At most this many comments per reader per minute. */
const COMMENT_BURST = 5;
const COMMENT_BODY_MAX = 2000;
/** Replies loaded with each page of threads. */
const MAX_REPLIES_PER_PAGE = 500;

const COMMENT_NOT_FOUND = () => Errors.notFound('That comment no longer exists.', 'COMMENT_NOT_FOUND');

/** "Ada O." — readers are shown by first name and initial. */
export function readerName(user: { firstName: string; lastName: string }): string {
  const first = user.firstName.trim();
  const initial = user.lastName.trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first || 'DOOAA reader';
}

/**
 * Reactions on the blog: likes on articles and comments, and threaded
 * comments. Readers comment with their DOOAA account; the team can reply from
 * the console. Counters on articles and comments move with every write, so
 * reads never count.
 */
@Injectable()
export class BlogCommunityService {
  private readonly logger = new Logger(BlogCommunityService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly blog: BlogService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /* --- Article likes ----------------------------------------------------- */

  async isLiked(articleId: string, userId?: string): Promise<boolean> {
    if (!userId) return false;
    return this.db.exists(blogLikes, { articleId, userId });
  }

  async like(user: AuthUser, slug: string): Promise<{ liked: boolean; likes: number }> {
    const { row } = await this.blog.liveBySlug(slug);
    try {
      await this.db.insert(blogLikes, { articleId: row.id, userId: user.id });
      const updated = await this.db.update(blogArticles, { id: row.id }, { $inc: { likes: 1 } });
      return { liked: true, likes: updated?.likes ?? row.likes + 1 };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { liked: true, likes: row.likes };
    }
  }

  async unlike(user: AuthUser, slug: string): Promise<{ liked: boolean; likes: number }> {
    const { row } = await this.blog.liveBySlug(slug);
    const removed = await this.db.delete(blogLikes, { articleId: row.id, userId: user.id });
    if (!removed) return { liked: false, likes: row.likes };
    const updated = await this.db.update(blogArticles, { id: row.id, likes: { $gt: 0 } }, { $inc: { likes: -1 } });
    return { liked: false, likes: updated?.likes ?? Math.max(0, row.likes - 1) };
  }

  /** Lightweight state for the storefront's like button and comment count. */
  async engagement(slug: string, userId?: string): Promise<{ likes: number; comments: number; liked: boolean }> {
    const { row } = await this.blog.liveBySlug(slug);
    return { likes: row.likes, comments: row.comments, liked: await this.isLiked(row.id, userId) };
  }

  /* --- Reading comments -------------------------------------------------- */

  private async authorsOf(rows: CommentRow[], article: Pick<BlogArticleRow, 'authorId'>): Promise<Map<string, CommentAuthor>> {
    const userIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => !!id))];
    const staffIds = [...new Set(rows.map((row) => row.staffId).filter((id): id is string => !!id))];
    const [people, team] = await Promise.all([
      userIds.length ? this.db.find(users, { id: { $in: userIds } }) : [],
      staffIds.length ? this.db.find(staff, { id: { $in: staffIds } }) : [],
    ]);
    const out = new Map<string, CommentAuthor>();
    for (const person of people) {
      out.set(`user:${person.id}`, {
        name: person.status === 'closed' ? 'Former member' : readerName(person),
        avatar: person.status === 'closed' ? null : person.avatarUrl,
        kind: 'user',
        badge: null,
      });
    }
    for (const member of team) {
      out.set(`staff:${member.id}`, {
        name: `${member.firstName} ${member.lastName}`.trim(),
        avatar: member.avatarUrl,
        kind: 'staff',
        badge: member.id === article.authorId ? 'Author' : 'DOOAA Team',
      });
    }
    return out;
  }

  private view(row: CommentRow, authors: Map<string, CommentAuthor>, likedIds: Set<string>, viewer?: { userId?: string }): CommentView {
    const key = row.userId ? `user:${row.userId}` : `staff:${row.staffId}`;
    const author = authors.get(key) ?? { name: row.authorName, avatar: null, kind: row.userId ? 'user' : 'staff', badge: row.staffId ? 'DOOAA Team' : null };
    const deleted = Boolean(row.deletedAt);
    return {
      id: row.id,
      parentId: row.parentId,
      rootId: row.rootId,
      depth: row.depth,
      body: deleted ? '' : row.body,
      deleted,
      author: deleted ? { name: row.deletedBy === 'staff' ? 'Removed' : 'Deleted', avatar: null, kind: author.kind, badge: null } : (author as CommentAuthor),
      replyTo: row.replyToName,
      likes: deleted ? 0 : row.likes,
      liked: !deleted && likedIds.has(row.id),
      replies: row.replies,
      mine: !deleted && Boolean(viewer?.userId && row.userId === viewer.userId),
      edited: !deleted && Boolean(row.editedAt),
      createdAt: row.createdAt.toISOString(),
      children: [],
    };
  }

  /** Builds views (with authors and the viewer's likes) for a set of rows. */
  private async views(rows: CommentRow[], article: Pick<BlogArticleRow, 'authorId'>, userId?: string): Promise<Map<string, CommentView>> {
    const authors = await this.authorsOf(rows, article);
    const liked = new Set<string>(
      userId && rows.length ? await this.db.distinct(blogCommentLikes, 'commentId', { userId, commentId: { $in: rows.map((row) => row.id) } }) : [],
    );
    return new Map(rows.map((row) => [row.id, this.view(row, authors, liked, { userId })]));
  }

  /** A page of threads: top-level comments with every reply under them, replies oldest first. */
  async thread(article: BlogArticleRow, query: { sort?: CommentSort; page?: number; limit?: number }, userId?: string): Promise<CommentPage> {
    const where: Where<CommentRow> = { articleId: article.id, parentId: null };
    const total = await this.db.count(blogComments, where);
    const window = pageWindow(total, query.page, query.limit ?? 10);
    const sort =
      query.sort === 'oldest' ? { createdAt: 1 as const } : query.sort === 'top' ? { likes: -1 as const, replies: -1 as const, createdAt: -1 as const } : { createdAt: -1 as const };
    const roots = await this.db.find(blogComments, where, { sort, skip: window.skip, limit: window.size });
    const replies = roots.length
      ? await this.db.find(blogComments, { rootId: { $in: roots.map((root) => root.id) } }, { sort: { createdAt: 1 }, limit: MAX_REPLIES_PER_PAGE })
      : [];
    const views = await this.views([...roots, ...replies], article, userId);
    for (const reply of replies) {
      const node = views.get(reply.id)!;
      const parent = reply.parentId ? views.get(reply.parentId) : undefined;
      if (parent) parent.children.push(node);
    }
    return { ...toPage(roots.map((root) => views.get(root.id)!), total, window), count: article.comments };
  }

  async threadBySlug(slug: string, query: { sort?: CommentSort; page?: number; limit?: number }, userId?: string): Promise<CommentPage> {
    const { row } = await this.blog.liveBySlug(slug);
    return this.thread(row, query, userId);
  }

  async threadForConsole(articleId: string, query: { sort?: CommentSort; page?: number; limit?: number }): Promise<CommentPage> {
    return this.thread(await this.blog.row(articleId), query);
  }

  /* --- Writing comments -------------------------------------------------- */

  private cleanBody(body: string): string {
    const text = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw Errors.badRequest('Write something before posting.', 'EMPTY_COMMENT');
    if (text.length > COMMENT_BODY_MAX) throw Errors.badRequest(`Keep comments under ${COMMENT_BODY_MAX} characters.`, 'COMMENT_TOO_LONG');
    return text;
  }

  /** Where a reply goes: under its parent, or beside it once the thread is as deep as it nests. */
  private async placement(article: BlogArticleRow, parentId: string | undefined, authors: Map<string, CommentAuthor> | null) {
    if (!parentId) return { parentId: null, rootId: null, depth: 0, replyToName: null, parent: null };
    const parent = isUuid(parentId) ? await this.db.findOne(blogComments, { id: parentId, articleId: article.id }) : null;
    if (!parent) throw COMMENT_NOT_FOUND();
    if (parent.deletedAt) throw Errors.conflict('That comment was deleted, so it can no longer be replied to.', 'COMMENT_DELETED');
    const rootId = parent.rootId ?? parent.id;
    if (parent.depth < BLOG_MAX_COMMENT_DEPTH) return { parentId: parent.id, rootId, depth: parent.depth + 1, replyToName: null, parent };
    const names = authors ?? (await this.authorsOf([parent], article));
    const name = names.get(parent.userId ? `user:${parent.userId}` : `staff:${parent.staffId}`)?.name ?? parent.authorName;
    return { parentId: parent.parentId, rootId, depth: parent.depth, replyToName: name, parent };
  }

  private async insertComment(article: BlogArticleRow, values: Omit<typeof blogComments.$inferInsert, 'articleId'>): Promise<CommentRow> {
    const created = await this.db.transaction(async (tx) => {
      const row = await tx.insert(blogComments, { ...values, articleId: article.id });
      await tx.update(blogArticles, { id: article.id }, { $inc: { comments: 1 } });
      if (row.parentId) await tx.update(blogComments, { id: row.parentId }, { $inc: { replies: 1 } });
      return row;
    });
    return created;
  }

  /** Lets the person replied to know, in their bell. */
  private async notifyReply(article: BlogArticleRow, target: CommentRow | null, replier: { userId?: string; name: string }, comment: CommentRow): Promise<void> {
    if (!target?.userId || target.userId === replier.userId) return;
    await this.notifications
      .notifyUser(target.userId, {
        type: 'blog.reply',
        title: `${replier.name} replied to your comment`,
        body: excerpt(comment.body, 120),
        tone: 'blue',
        link: `/blog/${article.slug}#comment-${comment.id}`,
        data: { articleId: article.id, commentId: comment.id },
        category: 'messages',
      })
      .catch((error) => this.logger.warn(explain('Could not send the reply notification', error)));
  }

  async comment(user: AuthUser, slug: string, input: { body: string; parentId?: string }): Promise<CommentView> {
    const { row: article } = await this.blog.liveBySlug(slug);
    const body = this.cleanBody(input.body);
    const recent = await this.db.count(blogComments, { userId: user.id, createdAt: { $gte: new Date(Date.now() - 60_000) } });
    if (recent >= COMMENT_BURST) throw Errors.tooMany('You are commenting very quickly. Wait a moment and try again.', 'COMMENT_RATE_LIMIT');
    const place = await this.placement(article, input.parentId, null);
    const name = readerName(user);
    const row = await this.insertComment(article, {
      userId: user.id,
      staffId: null,
      authorName: name,
      parentId: place.parentId,
      rootId: place.rootId,
      depth: place.depth,
      replyToName: place.replyToName,
      body,
    });
    void this.notifyReply(article, place.parent, { userId: user.id, name }, row);
    const views = await this.views([row], article, user.id);
    return views.get(row.id)!;
  }

  /** A reply (or a new thread) from the DOOAA team, written in the console. */
  async staffComment(member: AuthStaff, articleId: string, input: { body: string; parentId?: string }): Promise<CommentView> {
    const article = await this.blog.row(articleId);
    if (article.deletedAt) throw Errors.conflict('This article is in the trash.', 'ARTICLE_IN_TRASH');
    const body = this.cleanBody(input.body);
    const place = await this.placement(article, input.parentId, null);
    const name = `${member.firstName} ${member.lastName}`.trim();
    const row = await this.insertComment(article, {
      userId: null,
      staffId: member.id,
      authorName: name,
      parentId: place.parentId,
      rootId: place.rootId,
      depth: place.depth,
      replyToName: place.replyToName,
      body,
    });
    void this.notifyReply(article, place.parent, { name }, row);
    const views = await this.views([row], article);
    return views.get(row.id)!;
  }

  async edit(user: AuthUser, id: string, input: { body: string }): Promise<CommentView> {
    const row = isUuid(id) ? await this.db.findOne(blogComments, { id, userId: user.id, deletedAt: null }) : null;
    if (!row) throw COMMENT_NOT_FOUND();
    const body = this.cleanBody(input.body);
    const updated = body === row.body ? row : (await this.db.update(blogComments, { id: row.id }, { body, editedAt: new Date() }))!;
    const article = await this.blog.row(row.articleId);
    return (await this.views([updated], article, user.id)).get(updated.id)!;
  }

  /**
   * Removes a comment. One with replies keeps its place (its text and name
   * gone) so the conversation under it still reads; one without disappears,
   * and so does a deleted parent left with no replies.
   */
  private async remove(row: CommentRow, by: 'author' | 'staff'): Promise<{ id: string; removed: 'hidden' | 'deleted' }> {
    if (row.deletedAt) return { id: row.id, removed: 'hidden' };
    if (row.replies > 0) {
      await this.db.transaction(async (tx) => {
        await tx.update(blogComments, { id: row.id }, { deletedAt: new Date(), deletedBy: by, body: '' });
        await tx.update(blogArticles, { id: row.articleId, comments: { $gt: 0 } }, { $inc: { comments: -1 } });
      });
      await this.db.deleteMany(blogCommentLikes, { commentId: row.id });
      return { id: row.id, removed: 'hidden' };
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(blogComments, { id: row.id });
      await tx.update(blogArticles, { id: row.articleId, comments: { $gt: 0 } }, { $inc: { comments: -1 } });
      // Walk up: each parent loses a reply; a deleted parent with none left goes too.
      let parentId = row.parentId;
      while (parentId) {
        const parent = await tx.update(blogComments, { id: parentId, replies: { $gt: 0 } }, { $inc: { replies: -1 } });
        if (!parent || !parent.deletedAt || parent.replies > 0) break;
        await tx.delete(blogComments, { id: parent.id });
        parentId = parent.parentId;
      }
    });
    await this.db.deleteMany(blogCommentLikes, { commentId: row.id });
    return { id: row.id, removed: 'deleted' };
  }

  async deleteOwn(user: AuthUser, id: string) {
    const row = isUuid(id) ? await this.db.findOne(blogComments, { id, userId: user.id }) : null;
    if (!row) throw COMMENT_NOT_FOUND();
    return this.remove(row, 'author');
  }

  /** Moderation from the console. */
  async moderate(member: AuthStaff, id: string) {
    const row = isUuid(id) ? await this.db.findOne(blogComments, { id }) : null;
    if (!row) throw COMMENT_NOT_FOUND();
    const result = await this.remove(row, row.staffId === member.id ? 'author' : 'staff');
    const article = await this.db.findOne(blogArticles, { id: row.articleId });
    await this.audit.record(member, {
      action: 'Removed a blog comment',
      target: `${row.authorName} on “${article?.title ?? 'an article'}”`,
      targetType: 'blog-comment',
      targetId: row.id,
      meta: { body: row.body.slice(0, 500) },
    });
    return result;
  }

  /* --- Comment likes ----------------------------------------------------- */

  private async liveComment(id: string): Promise<CommentRow> {
    const row = isUuid(id) ? await this.db.findOne(blogComments, { id, deletedAt: null }) : null;
    if (!row) throw COMMENT_NOT_FOUND();
    // The article must still be readable.
    const article = await this.db.findOne(blogArticles, { id: row.articleId, status: 'published', deletedAt: null, publishedAt: { $lte: new Date() } });
    if (!article) throw COMMENT_NOT_FOUND();
    return row;
  }

  async likeComment(user: AuthUser, id: string): Promise<{ liked: boolean; likes: number }> {
    const row = await this.liveComment(id);
    try {
      await this.db.insert(blogCommentLikes, { commentId: row.id, userId: user.id });
      const updated = await this.db.update(blogComments, { id: row.id }, { $inc: { likes: 1 } });
      return { liked: true, likes: updated?.likes ?? row.likes + 1 };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { liked: true, likes: row.likes };
    }
  }

  async unlikeComment(user: AuthUser, id: string): Promise<{ liked: boolean; likes: number }> {
    const row = await this.liveComment(id);
    const removed = await this.db.delete(blogCommentLikes, { commentId: row.id, userId: user.id });
    if (!removed) return { liked: false, likes: row.likes };
    const updated = await this.db.update(blogComments, { id: row.id, likes: { $gt: 0 } }, { $inc: { likes: -1 } });
    return { liked: false, likes: updated?.likes ?? Math.max(0, row.likes - 1) };
  }
}
