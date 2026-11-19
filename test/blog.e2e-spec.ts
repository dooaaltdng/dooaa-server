import request from 'supertest';
import { blogArticles, blogViews, notifications, settings as settingsTable } from '../src/database/schema';
import { DEFAULT_ROLE_PERMISSIONS } from '../src/common/domain';
import { SettingsService } from '../src/modules/settings/settings.service';
import { createTestApp, type TestApp } from './utils/app';
import { eventually } from './utils/eventually';
import { registerUser, staffToken } from './utils/factories';
import { API, Http, data, failure } from './utils/http';

const BODY = `<h2>Meet in public</h2><p>${'Always meet the seller somewhere busy and check the item before you pay. '.repeat(12)}</p><script>alert(1)</script>`;

describe('Blog (e2e)', () => {
  let t: TestApp;
  let http: Http;
  let writer: Awaited<ReturnType<typeof staffToken>>;
  let moderator: Awaited<ReturnType<typeof staffToken>>;
  let social: Awaited<ReturnType<typeof staffToken>>;
  let reader: Awaited<ReturnType<typeof registerUser>>;
  let other: Awaited<ReturnType<typeof registerUser>>;

  /** A published article, written by the superadmin. */
  async function published(input: Record<string, unknown> = {}) {
    const draft = data(await http.post('/admin/blog/articles', { title: 'Five ways to buy safely', body: BODY, category: 'safety', tags: ['Safety', 'Buying'], ...input }, writer.token));
    return data(await http.post(`/admin/blog/articles/${draft.id}/publish`, { publishAt: null }, writer.token));
  }

  beforeAll(async () => {
    t = await createTestApp();
    http = new Http(t);
    writer = await staffToken(t, 'superadmin', { firstName: 'Tolu', lastName: 'Writer' });
    moderator = await staffToken(t, 'moderator', { firstName: 'Mo', lastName: 'Derator' });
    social = await staffToken(t, 'social', { firstName: 'Sade', lastName: 'Social' });
    reader = await registerUser(t, { firstName: 'Ada', lastName: 'Obi' });
    other = await registerUser(t, { firstName: 'Bayo', lastName: 'Ade' });
  });
  afterAll(async () => t.close());

  describe('permissions', () => {
    it('lets roles with blog.write write, and keeps everyone else out', async () => {
      // Moderators read and moderate, but cannot write.
      data(await http.get('/admin/blog/articles', moderator.token));
      failure(await http.post('/admin/blog/articles', { title: 'Nope' }, moderator.token), 403, 'PERMISSION_DENIED');
      // The Social Media Manager writes by default (the blog routes are open to that role).
      const draft = data(await http.post('/admin/blog/articles', { title: 'From social' }, social.token));
      expect(draft.author.name).toBe('Sade Social');
      // Readers' tokens never reach the console.
      failure(await http.get('/admin/blog/articles', reader.token), 401);
    });

    it('follows the role matrix: revoking blog.write locks a role out at once', async () => {
      const admin = await staffToken(t, 'admin');
      data(await http.post('/admin/blog/articles', { title: 'Admin draft' }, admin.token));
      const roles = { ...DEFAULT_ROLE_PERMISSIONS, admin: DEFAULT_ROLE_PERMISSIONS.admin.filter((p) => p !== 'blog.write' && p !== 'blog.moderate') };
      data(await http.put('/admin/settings/roles', { value: roles }, writer.token));
      failure(await http.post('/admin/blog/articles', { title: 'Blocked' }, admin.token), 403, 'PERMISSION_DENIED');
      failure(await http.get('/admin/blog/overview', admin.token), 403, 'PERMISSION_DENIED');
      // Restore the defaults for the rest of the suite.
      await t.db.delete(settingsTable, { id: 'platform' });
      await t.get<SettingsService>(SettingsService).invalidate();
      await t.db.upsert(settingsTable, { id: 'platform' }, { $set: { 'values.escrow': { enabled: true } } });
      await t.get<SettingsService>(SettingsService).invalidate();
      data(await http.post('/admin/blog/articles', { title: 'Allowed again' }, admin.token));
    });

    it('only lists authors who can write', async () => {
      const meta = data(await http.get('/admin/blog/meta', writer.token));
      const names = meta.authors.map((author: { name: string }) => author.name);
      expect(names).toContain('Tolu Writer');
      expect(names).toContain('Sade Social');
      expect(names).not.toContain('Mo Derator');
      expect(meta.categories).toContainEqual({ value: 'safety', label: 'Safety' });
      expect(meta.textSize).toEqual({ min: 15, max: 21, default: 17 });
    });
  });

  describe('writing', () => {
    it('creates a draft, sanitises the body and works out the reading time', async () => {
      const draft = data(await http.post('/admin/blog/articles', { title: '  How to   sell a phone  ', body: BODY }, writer.token));
      expect(draft).toMatchObject({ title: 'How to sell a phone', slug: 'how-to-sell-a-phone', state: 'draft', publishedAt: null, readMinutes: 1, category: 'guides', theme: 'default', textSize: 17 });
      expect(draft.body).not.toContain('<script');
      expect(draft.wordCount).toBeGreaterThan(100);
      expect(draft.excerpt).toMatch(/^Meet in public Always meet/);
      expect(draft.author).toMatchObject({ name: 'Tolu Writer' });
    });

    it('lets a draft slug follow its title until set by hand, and keeps slugs unique', async () => {
      const a = data(await http.post('/admin/blog/articles', { title: 'Escrow explained' }, writer.token));
      const b = data(await http.post('/admin/blog/articles', { title: 'Escrow explained' }, writer.token));
      expect(a.slug).toBe('escrow-explained');
      expect(b.slug).toBe('escrow-explained-2');
      const renamed = data(await http.patch(`/admin/blog/articles/${a.id}`, { title: 'Escrow, simply explained' }, writer.token));
      expect(renamed.slug).toBe('escrow-simply-explained');
      const custom = data(await http.patch(`/admin/blog/articles/${a.id}`, { slug: 'Escrow 101' }, writer.token));
      expect(custom).toMatchObject({ slug: 'escrow-101', slugCustom: true });
      const retitled = data(await http.patch(`/admin/blog/articles/${a.id}`, { title: 'Another title' }, writer.token));
      expect(retitled.slug).toBe('escrow-101');
    });

    it('validates the editor’s settings', async () => {
      const draft = data(await http.post('/admin/blog/articles', { title: 'Settings' }, writer.token));
      const saved = data(
        await http.patch(`/admin/blog/articles/${draft.id}`, { theme: 'mint', textSize: 19, lineSpacing: 1.83, tags: ['#Phones', 'phones', 'Lagos'], featured: true, excerpt: ' Short  line ' }, writer.token),
      );
      expect(saved).toMatchObject({ theme: 'mint', textSize: 19, lineSpacing: 1.85, tags: ['Phones', 'Lagos'], featured: true, excerpt: 'Short line', writtenExcerpt: 'Short line' });
      failure(await http.patch(`/admin/blog/articles/${draft.id}`, { theme: 'neon' }, writer.token), 400);
      failure(await http.patch(`/admin/blog/articles/${draft.id}`, { textSize: 40 }, writer.token), 400);
      failure(await http.patch(`/admin/blog/articles/${draft.id}`, { coverUrl: 'javascript:alert(1)' }, writer.token), 400, 'INVALID_COVER');
      failure(await http.patch(`/admin/blog/articles/${draft.id}`, { authorId: moderator.id }, writer.token), 400, 'INVALID_AUTHOR');
      const reassigned = data(await http.patch(`/admin/blog/articles/${draft.id}`, { authorId: social.id }, writer.token));
      expect(reassigned.author.name).toBe('Sade Social');
    });

    it('refuses to publish an empty article', async () => {
      const empty = data(await http.post('/admin/blog/articles', {}, writer.token));
      failure(await http.post(`/admin/blog/articles/${empty.id}/publish`, {}, writer.token), 400, 'TITLE_REQUIRED');
      data(await http.patch(`/admin/blog/articles/${empty.id}`, { title: 'Has a title' }, writer.token));
      failure(await http.post(`/admin/blog/articles/${empty.id}/publish`, {}, writer.token), 400, 'BODY_REQUIRED');
    });
  });

  describe('publishing', () => {
    it('publishes now, shows it on the storefront and keeps old links working after a rename', async () => {
      const article = await published({ title: 'Spotting a fake iPhone', coverAlt: '  Three iPhones   on a desk ' });
      expect(article).toMatchObject({ state: 'published', coverAlt: 'Three iPhones on a desk', path: `/blog/${article.slug}` });
      expect(article.firstPublishedAt).toBeTruthy();
      const page = data(await http.get(`/blog/articles/${article.slug}`));
      expect(page).toMatchObject({ title: 'Spotting a fake iPhone', coverAlt: 'Three iPhones on a desk', moved: false, liked: false, categoryLabel: 'Safety', author: { name: 'Tolu Writer' } });
      expect(page.body).not.toContain('script');

      const renamed = data(await http.patch(`/admin/blog/articles/${article.id}`, { slug: 'fake-iphone-guide' }, writer.token));
      expect(renamed.slug).toBe('fake-iphone-guide');
      const old = data(await http.get(`/blog/articles/${article.slug}`));
      expect(old).toMatchObject({ slug: 'fake-iphone-guide', moved: true });
      // Nobody else can take the old slug.
      const clash = data(await http.post('/admin/blog/articles', { title: 'x', slug: article.slug }, writer.token));
      expect(clash.slug).toBe(`${article.slug}-2`);
    });

    it('schedules an article for later and keeps it off the storefront until then', async () => {
      const draft = data(await http.post('/admin/blog/articles', { title: 'Coming soon', body: BODY }, writer.token));
      const later = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
      const scheduled = data(await http.post(`/admin/blog/articles/${draft.id}/publish`, { publishAt: later }, writer.token));
      expect(scheduled.state).toBe('scheduled');
      failure(await http.get(`/blog/articles/${draft.slug}`), 404, 'ARTICLE_NOT_FOUND');
      const list = data(await http.get('/admin/blog/articles?status=scheduled', writer.token));
      expect(list.rows.map((row: { id: string }) => row.id)).toContain(draft.id);
      expect(list.counts.scheduled).toBeGreaterThanOrEqual(1);
      // Time passes.
      await t.db.update(blogArticles, { id: draft.id }, { publishedAt: new Date(Date.now() - 1000) });
      data(await http.get(`/blog/articles/${draft.slug}`));
    });

    it('unpublishes, trashes, restores and deletes for good', async () => {
      const article = await published({ title: 'Short lived' });
      const back = data(await http.post(`/admin/blog/articles/${article.id}/unpublish`, {}, writer.token));
      expect(back.state).toBe('draft');
      failure(await http.get(`/blog/articles/${article.slug}`), 404);
      failure(await http.delete(`/admin/blog/articles/${article.id}/permanent`, writer.token), 409, 'ARTICLE_NOT_IN_TRASH');
      const trashed = data(await http.delete(`/admin/blog/articles/${article.id}`, writer.token));
      expect(trashed.deletedAt).toBeTruthy();
      failure(await http.post(`/admin/blog/articles/${article.id}/publish`, {}, writer.token), 409, 'ARTICLE_IN_TRASH');
      expect(data(await http.get('/admin/blog/articles?status=trash', writer.token)).rows.some((row: { id: string }) => row.id === article.id)).toBe(true);
      data(await http.post(`/admin/blog/articles/${article.id}/restore`, {}, writer.token));
      data(await http.delete(`/admin/blog/articles/${article.id}`, writer.token));
      data(await http.delete(`/admin/blog/articles/${article.id}/permanent`, writer.token));
      failure(await http.get(`/admin/blog/articles/${article.id}`, writer.token), 404, 'ARTICLE_NOT_FOUND');
    });

    it('lists live articles newest first with the featured one apart, and filters by tag', async () => {
      const featured = await published({ title: 'The featured one', featured: true, tags: ['Escrow'] });
      await published({ title: 'Newer but not featured', tags: ['Phones'] });
      const first = data(await http.get('/blog/articles?featured=1&limit=3'));
      expect(first.featured.id).toBe(featured.id);
      expect(first.rows.map((row: { id: string }) => row.id)).not.toContain(featured.id);
      expect(first.rows[0].title).toBe('Newer but not featured');
      const second = data(await http.get(`/blog/articles?page=2&limit=3&exclude=${featured.id}`));
      expect(second.rows.map((row: { id: string }) => row.id)).not.toContain(featured.id);
      const firstScreen = data(await http.get('/blog/articles?featured=1&limit=1'));
      const more = data(await http.get(`/blog/articles?offset=1&limit=1&exclude=${featured.id}`));
      expect(more.rows[0].id).not.toBe(firstScreen.rows[0].id);
      expect(more.rows[0].id).not.toBe(featured.id);
      expect(typeof more.hasMore).toBe('boolean');
      const searched = data(await http.get(`/blog/articles?q=${encodeURIComponent('newer but')}`));
      expect(searched.rows.map((row: { title: string }) => row.title)).toEqual(['Newer but not featured']);
      const byBody = data(await http.get('/blog/articles?q=somewhere%20busy'));
      expect(byBody.total).toBeGreaterThanOrEqual(2);
      expect(data(await http.get('/blog/articles?q=zzzz-nothing')).total).toBe(0);
      const tagged = data(await http.get('/blog/articles?tag=escrow'));
      expect(tagged.rows.map((row: { title: string }) => row.title)).toEqual(['The featured one']);
      const tags = data(await http.get('/blog/tags'));
      expect(tags.map((row: { tag: string }) => row.tag)).toEqual(expect.arrayContaining(['Escrow', 'Phones', 'Safety']));
      expect(tags.find((row: { tag: string }) => row.tag === 'Escrow')).toMatchObject({ slug: 'escrow' });
      const sitemap = data(await http.get('/blog/sitemap'));
      expect(sitemap.map((row: { slug: string }) => row.slug)).toContain(featured.slug);
    });
  });

  describe('search engines', () => {
    it('lands tags by slug, whatever their spelling, and names the tag for the heading', async () => {
      const article = await published({ title: 'Paying safely', tags: ['Escrow & Payments', 'Lagos Tips'] });
      expect(article).toMatchObject({ seoTitle: '', seoDescription: '' });
      const card = data(await http.get(`/blog/articles/${article.slug}`));
      expect(card.tagLinks).toEqual([
        { tag: 'Escrow & Payments', slug: 'escrow-and-payments' },
        { tag: 'Lagos Tips', slug: 'lagos-tips' },
      ]);
      const landing = data(await http.get('/blog/articles?tag=escrow-and-payments'));
      expect(landing.rows.map((row: { id: string }) => row.id)).toContain(article.id);
      expect(landing.tag).toBe('Escrow & Payments');
      expect(data(await http.get('/blog/articles?tag=Lagos%20Tips')).rows.map((row: { id: string }) => row.id)).toContain(article.id);
      expect(data(await http.get('/blog/articles?tag=nothing-here')).total).toBe(0);
    });

    it('falls back to the title and excerpt for search results, and takes the writer’s own when given', async () => {
      const article = await published({ title: 'Default SEO', excerpt: 'The card line.' });
      const plain = data(await http.get(`/blog/articles/${article.slug}`));
      expect(plain).toMatchObject({ seoTitle: 'Default SEO', seoDescription: 'The card line.', wordCount: expect.any(Number) });
      expect(plain.updatedAt).toBeTruthy();
      const long = 'x'.repeat(200);
      const saved = data(await http.patch(`/admin/blog/articles/${article.id}`, { seoTitle: '  Buy safely  on DOOAA ', seoDescription: long }, writer.token));
      expect(saved).toMatchObject({ seoTitle: 'Buy safely on DOOAA', seoDescription: 'x'.repeat(170) });
      expect(data(await http.get(`/blog/articles/${article.slug}`))).toMatchObject({ seoTitle: 'Buy safely on DOOAA', seoDescription: 'x'.repeat(170) });
    });

    it('counts live articles per category and lists the sitemap with dates and covers', async () => {
      await published({ title: 'A story', category: 'stories', coverUrl: 'https://res.cloudinary.com/demo/story.jpg' });
      const categories = data(await http.get('/blog/categories'));
      expect(categories).toHaveLength(7);
      expect(categories.find((row: { value: string }) => row.value === 'stories')).toMatchObject({ label: 'Stories', count: 1 });
      const sitemap = data(await http.get('/blog/sitemap'));
      expect(sitemap.find((row: { title: string }) => row.title === 'A story')).toMatchObject({ coverUrl: 'https://res.cloudinary.com/demo/story.jpg', publishedAt: expect.any(String), updatedAt: expect.any(String) });
    });
  });

  describe('likes', () => {
    it('toggles a like once per reader and needs an account', async () => {
      const article = await published({ title: 'Likeable' });
      failure(await http.put(`/blog/articles/${article.slug}/like`), 401);
      expect(data(await http.put(`/blog/articles/${article.slug}/like`, {}, reader.token))).toEqual({ liked: true, likes: 1 });
      expect(data(await http.put(`/blog/articles/${article.slug}/like`, {}, reader.token))).toEqual({ liked: true, likes: 1 });
      expect(data(await http.put(`/blog/articles/${article.slug}/like`, {}, other.token))).toEqual({ liked: true, likes: 2 });
      expect(data(await http.get(`/blog/articles/${article.slug}`, reader.token)).liked).toBe(true);
      expect(data(await http.get(`/blog/articles/${article.slug}/engagement`, reader.token))).toEqual({ likes: 2, comments: 0, liked: true });
      expect(data(await http.delete(`/blog/articles/${article.slug}/like`, reader.token))).toEqual({ liked: false, likes: 1 });
      expect(data(await http.delete(`/blog/articles/${article.slug}/like`, reader.token))).toEqual({ liked: false, likes: 1 });
    });
  });

  describe('comments', () => {
    it('threads replies, nests two levels deep and then replies alongside with a mention', async () => {
      const article = await published({ title: 'Discuss this' });
      failure(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Hi' }), 401);
      const root = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: '  Great tips!  ' }, reader.token));
      expect(root).toMatchObject({ body: 'Great tips!', depth: 0, author: { name: 'Ada O.', kind: 'user', badge: null }, mine: true, likes: 0 });
      const reply = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Agreed', parentId: root.id }, other.token));
      expect(reply).toMatchObject({ parentId: root.id, rootId: root.id, depth: 1 });
      const deep = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Me too', parentId: reply.id }, reader.token));
      expect(deep).toMatchObject({ parentId: reply.id, depth: 2 });
      const deeper = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Same', parentId: deep.id }, other.token));
      expect(deeper).toMatchObject({ parentId: reply.id, depth: 2, replyTo: 'Ada O.' });

      const thread = data(await http.get(`/blog/articles/${article.slug}/comments`, reader.token));
      expect(thread).toMatchObject({ total: 1, count: 4 });
      expect(thread.rows[0].children[0].children.map((c: { body: string }) => c.body)).toEqual(['Me too', 'Same']);
      expect(thread.rows[0].children[0].mine).toBe(false);
      expect(data(await http.get(`/blog/articles/${article.slug}`)).comments).toBe(4);

      // The person replied to hears about it.
      await eventually(async () => {
        const bell = await t.db.find(notifications, { recipientId: reader.id, type: 'blog.reply' });
        expect(bell.length).toBeGreaterThanOrEqual(1);
        expect(bell[0].link).toContain(`/blog/${article.slug}#comment-`);
      });
    });

    it('edits and deletes your own comments only; a comment with replies keeps its place', async () => {
      const article = await published({ title: 'Edit me' });
      const root = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'First' }, reader.token));
      failure(await http.put(`/blog/comments/${root.id}`, { body: 'Hacked' }, other.token), 404, 'COMMENT_NOT_FOUND');
      const edited = data(await http.put(`/blog/comments/${root.id}`, { body: 'First (edited)' }, reader.token));
      expect(edited).toMatchObject({ body: 'First (edited)', edited: true });
      const reply = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Reply', parentId: root.id }, other.token));
      failure(await http.delete(`/blog/comments/${root.id}`, other.token), 404);
      expect(data(await http.delete(`/blog/comments/${root.id}`, reader.token))).toEqual({ id: root.id, removed: 'hidden' });
      let thread = data(await http.get(`/blog/articles/${article.slug}/comments`));
      expect(thread.rows[0]).toMatchObject({ deleted: true, body: '', author: { name: 'Deleted' } });
      expect(thread.count).toBe(1);
      failure(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'x', parentId: root.id }, reader.token), 409, 'COMMENT_DELETED');
      // Removing the last reply takes the deleted parent with it.
      expect(data(await http.delete(`/blog/comments/${reply.id}`, other.token))).toEqual({ id: reply.id, removed: 'deleted' });
      thread = data(await http.get(`/blog/articles/${article.slug}/comments`));
      expect(thread).toMatchObject({ total: 0, count: 0 });
    });

    it('likes comments, sorts by top, and rejects empty or rapid-fire comments', async () => {
      const article = await published({ title: 'Popular' });
      const a = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Older' }, reader.token));
      const b = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Newer' }, reader.token));
      expect(data(await http.put(`/blog/comments/${a.id}/like`, {}, other.token))).toEqual({ liked: true, likes: 1 });
      expect(data(await http.put(`/blog/comments/${a.id}/like`, {}, other.token))).toEqual({ liked: true, likes: 1 });
      const top = data(await http.get(`/blog/articles/${article.slug}/comments?sort=top`, other.token));
      expect(top.rows.map((row: { id: string }) => row.id)).toEqual([a.id, b.id]);
      expect(top.rows[0].liked).toBe(true);
      const newest = data(await http.get(`/blog/articles/${article.slug}/comments`));
      expect(newest.rows[0].id).toBe(b.id);
      expect(data(await http.delete(`/blog/comments/${a.id}/like`, other.token))).toEqual({ liked: false, likes: 0 });
      failure(await http.post(`/blog/articles/${article.slug}/comments`, { body: '   ' }, other.token), 400, 'EMPTY_COMMENT');
      const burst = await registerUser(t);
      for (let i = 0; i < 5; i += 1) data(await http.post(`/blog/articles/${article.slug}/comments`, { body: `n${i}` }, burst.token));
      failure(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'too fast' }, burst.token), 429, 'COMMENT_RATE_LIMIT');
    });

    it('needs a confirmed email to comment', async () => {
      const article = await published({ title: 'Verified only' });
      const fresh = await registerUser(t, { verifyEmail: false });
      failure(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Hello' }, fresh.token), 403, 'EMAIL_NOT_VERIFIED');
    });

    it('lets the team reply from the console with a badge, and moderators remove comments', async () => {
      const article = await published({ title: 'Team replies' });
      const root = data(await http.post(`/blog/articles/${article.slug}/comments`, { body: 'Question?' }, reader.token));
      const answer = data(await http.post(`/admin/blog/articles/${article.id}/comments`, { body: 'Answer!', parentId: root.id }, writer.token));
      expect(answer.author).toMatchObject({ name: 'Tolu Writer', kind: 'staff', badge: 'Author' });
      const team = data(await http.post(`/admin/blog/articles/${article.id}/comments`, { body: 'Also' }, moderator.token));
      expect(team.author.badge).toBe('DOOAA Team');
      failure(await http.delete(`/admin/blog/comments/${root.id}`, social.token), 403, 'PERMISSION_DENIED');
      expect(data(await http.delete(`/admin/blog/comments/${root.id}`, moderator.token))).toEqual({ id: root.id, removed: 'hidden' });
      const thread = data(await http.get(`/admin/blog/articles/${article.id}/comments`, moderator.token));
      const removed = thread.rows.find((row: { id: string }) => row.id === root.id);
      expect(removed).toMatchObject({ deleted: true, author: { name: 'Removed' } });
      const audit = data(await http.get('/admin/audit?search=blog%20comment', writer.token));
      expect(audit.rows[0]).toMatchObject({ action: 'Removed a blog comment' });
    });
  });

  describe('reading stats', () => {
    it('counts a read once per half hour, records its source and how long it lasted', async () => {
      const article = await published({ title: 'Tracked' });
      const visitorId = 'visitor_abc12345';
      const first = data(await http.post(`/blog/articles/${article.slug}/views`, { visitorId, referrer: 'https://www.google.com/' }));
      expect(first.counted).toBe(true);
      const again = data(await http.post(`/blog/articles/${article.slug}/views`, { visitorId }));
      expect(again).toEqual({ viewId: first.viewId, counted: false });
      data(await http.post(`/blog/articles/${article.slug}/views`, { visitorId: 'visitor_def67890', referrer: 'http://localhost:3000/article' }));
      failure(await http.post(`/blog/articles/${article.slug}/views`, { visitorId: 'bad id!' }), 400);

      // The beacon arrives as text/plain.
      const beacon = await request(t.server).post(`${API}/blog/views/${first.viewId}/read`).set('Content-Type', 'text/plain').send(JSON.stringify({ seconds: 95, completed: true }));
      expect(beacon.body.data).toEqual({ recorded: true });
      data(await http.post(`/blog/views/${first.viewId}/read`, { seconds: 30, completed: false }));
      const view = await t.db.findOne(blogViews, { id: first.viewId });
      expect(view).toMatchObject({ seconds: 95, completed: true, source: 'google' });
      const internal = await t.db.findOne(blogViews, { visitorId: 'visitor_def67890' });
      expect(internal?.source).toBe('internal');
      expect(data(await http.get(`/admin/blog/articles/${article.id}`, writer.token)).views).toBe(2);
    });

    it('reports the dashboard numbers with changes against the period before', async () => {
      const article = await published({ title: 'Dashboard numbers', category: 'payments' });
      for (const id of ['dash_visitor_1', 'dash_visitor_2', 'dash_visitor_3']) {
        const { viewId } = data(await http.post(`/blog/articles/${article.slug}/views`, { visitorId: id, utmSource: 'instagram' }));
        data(await http.post(`/blog/views/${viewId}/read`, { seconds: id.endsWith('1') ? 5 : 120, completed: !id.endsWith('1') }));
      }
      data(await http.put(`/blog/articles/${article.slug}/like`, {}, reader.token));
      const overview = data(await http.get('/admin/blog/overview?range=30d&category=payments', writer.token));
      expect(overview.totals.views).toMatchObject({ value: 3, previous: 0, change: null });
      expect(overview.totals.visitors.value).toBe(3);
      expect(overview.totals.engagement.value).toBeCloseTo(33.3, 1);
      expect(overview.sources[0]).toMatchObject({ id: 'instagram', label: 'Instagram', visits: 3, share: 100 });
      expect(overview.impressions).toMatchObject({ total: 3, bounceRate: 33.3, averageSeconds: 82, readThrough: 66.7 });
      expect(overview.top[0]).toMatchObject({ id: article.id, views: 3, likes: 1 });
      expect(overview.recent[0].id).toBe(article.id);
      expect(overview.counts.published).toBe(1);
      // Last month's reads make this month's change a percentage.
      await t.db.insert(blogViews, { articleId: article.id, visitorId: 'old_visitor_1', day: '2000-01-01', source: 'other', createdAt: new Date(Date.now() - 40 * 24 * 3600_000) } as never);
      await t.db.insert(blogViews, { articleId: article.id, visitorId: 'old_visitor_2', day: '2000-01-01', source: 'other', createdAt: new Date(Date.now() - 45 * 24 * 3600_000) } as never);
      const compared = data(await http.get('/admin/blog/overview?range=30d&category=payments', writer.token));
      expect(compared.totals.views).toMatchObject({ value: 3, previous: 2, change: 50 });
    });

    it('lists the month’s articles by day for the calendar', async () => {
      const article = await published({ title: 'On the calendar' });
      const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(article.publishedAt)).slice(0, 7);
      const calendar = data(await http.get(`/admin/blog/calendar?month=${month}`, writer.token));
      expect(calendar.entries.map((entry: { id: string }) => entry.id)).toContain(article.id);
      expect(Object.values(calendar.days).reduce((a: number, b) => a + (b as number), 0)).toBe(calendar.entries.length);
      failure(await http.get('/admin/blog/calendar?month=2026-13', writer.token), 400, 'INVALID_MONTH');
    });
  });
});
