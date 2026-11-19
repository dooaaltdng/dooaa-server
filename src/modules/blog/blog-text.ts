import sanitizeHtml from 'sanitize-html';
import { BLOG_MAX_TAGS } from '../../common/domain';
import { excerpt, slugify } from '../../common/util/text';

/**
 * What the blog editor may publish: two heading levels under the article's
 * own title, paragraphs, emphasis (bold, italic, underline, strikethrough),
 * links, both list kinds, quotes, rules and images. Alignment is the only
 * inline style. Scripts, styles, frames and event handlers never survive.
 */
export function sanitizeArticle(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'img', 'span', 'div'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      '*': ['style'],
    },
    allowedStyles: {
      '*': { 'text-align': [/^(left|right|center|justify)$/] },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    // The editor's own title is the page's h1; a pasted h1 or h4 becomes the nearest allowed level.
    transformTags: {
      h1: 'h2',
      h4: 'h3',
      h5: 'h3',
      h6: 'h3',
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', ...(attribs.target ? { target: '_blank' } : {}) },
      }),
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, alt: attribs.alt ?? '' } }),
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
}

/** The words a reader actually reads: tags removed, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<\/(p|h2|h3|li|blockquote|div)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function wordCount(html: string): number {
  const text = plainText(html);
  return text ? text.split(' ').length : 0;
}

/** At 225 words a minute, plus a few seconds per image; never less than one minute. */
export function readMinutes(html: string): number {
  const images = (html.match(/<img\b/gi) ?? []).length;
  const seconds = (wordCount(html) / 225) * 60 + images * 10;
  return Math.max(1, Math.round(seconds / 60));
}

/** The card's line: the author's own excerpt, or the opening of the body. */
export function excerptFor(body: string, written?: string | null): string {
  const own = written?.replace(/\s+/g, ' ').trim();
  return own ? own : excerpt(plainText(body), 180);
}

/** Up to five tags, trimmed, without "#", without case-insensitive repeats. */
export function normalizeTags(tags: string[] | undefined | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === BLOG_MAX_TAGS) break;
  }
  return out;
}

/** A tag's URL slug: "Escrow & Payments" → "escrow-and-payments". */
export function tagSlug(tag: string): string {
  return slugify(tag).slice(0, 40).replace(/-+$/g, '');
}

/** Search-result copy: whitespace collapsed and cut to what search engines show. */
export function seoText(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A URL slug from a title; "article" when the title has no usable characters. */
export function articleSlug(title: string): string {
  return slugify(title).slice(0, 80).replace(/-+$/g, '') || 'article';
}
