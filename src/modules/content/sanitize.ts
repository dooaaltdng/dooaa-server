import sanitizeHtml from 'sanitize-html';

/**
 * What the console's rich-text editor may publish: headings, emphasis,
 * links, lists, quotes and paragraph alignment. Scripts, styles, event
 * handlers and anything else are stripped before a body is stored.
 */
export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'span', 'div', 'hr'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      '*': ['style'],
    },
    allowedStyles: {
      '*': { 'text-align': [/^(left|right|center|justify)$/] },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', ...(attribs.target ? { target: '_blank' } : {}) },
      }),
    },
  });
}
