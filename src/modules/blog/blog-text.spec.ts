import { articleSlug, excerptFor, normalizeTags, plainText, readMinutes, sanitizeArticle, wordCount } from './blog-text';

describe('blog article sanitising', () => {
  it('keeps everything the editor can produce', () => {
    const html =
      '<h2>Intro</h2><h3>Sub</h3><p style="text-align:center"><b>B</b> <i>I</i> <u>U</u> <s>S</s> <strike>T</strike></p>' +
      '<ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Q</blockquote><hr /><p><img src="https://res.cloudinary.com/x.jpg" alt="Phone" /></p>';
    expect(sanitizeArticle(html)).toBe(html);
  });

  it('strips scripts, handlers, frames, styles and javascript: links', () => {
    const dirty =
      '<p onclick="x()" style="color:red">Hi<script>alert(1)</script></p><iframe src="https://evil"></iframe>' +
      '<a href="javascript:alert(1)">x</a><img src="javascript:alert(1)" onerror="x()"><style>p{}</style>';
    const clean = sanitizeArticle(dirty);
    expect(clean).not.toMatch(/script|onclick|iframe|javascript:|onerror|style|color/i);
    expect(clean).toContain('<p>Hi</p>');
    expect(clean).not.toContain('<img');
  });

  it('demotes headings to the levels under the title and hardens links', () => {
    expect(sanitizeArticle('<h1>A</h1><h4>B</h4>')).toBe('<h2>A</h2><h3>B</h3>');
    expect(sanitizeArticle('<a href="https://dooaa.com" target="_self">x</a>')).toBe('<a href="https://dooaa.com" target="_blank" rel="noopener noreferrer">x</a>');
  });

  it('gives images an alt and drops data: images', () => {
    expect(sanitizeArticle('<img src="https://a.b/c.png">')).toBe('<img src="https://a.b/c.png" alt="" />');
    expect(sanitizeArticle('<img src="data:image/png;base64,AAAA">')).toBe('');
  });
});

describe('blog text helpers', () => {
  it('reads plain text out of rich text', () => {
    expect(plainText('<h2>Safe&nbsp;buying</h2><p>Meet in <b>public</b> &amp; check it.</p>')).toBe('Safe buying Meet in public & check it.');
    expect(wordCount('<p>one two</p><p>three</p>')).toBe(3);
    expect(wordCount('<p></p>')).toBe(0);
  });

  it('estimates reading time at 225 words a minute, one minute at least', () => {
    expect(readMinutes('<p>short</p>')).toBe(1);
    expect(readMinutes(`<p>${'word '.repeat(900)}</p>`)).toBe(4);
    expect(readMinutes(`<p>${'word '.repeat(450)}</p>${'<img src="https://a.b/c.png">'.repeat(12)}`)).toBe(4);
  });

  it('uses the written excerpt, else the opening of the body', () => {
    expect(excerptFor('<p>Body text</p>', '  Own   line ')).toBe('Own line');
    expect(excerptFor(`<p>${'a '.repeat(200)}</p>`, '')).toMatch(/…$/);
  });

  it('normalises tags', () => {
    expect(normalizeTags(['#Escrow', 'escrow', '  Phones  ', '', 'a', 'b', 'c', 'd'])).toEqual(['Escrow', 'Phones', 'a', 'b', 'c']);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it('makes slugs from titles', () => {
    expect(articleSlug('How to Sell Your Phone Safely in Lagos!')).toBe('how-to-sell-your-phone-safely-in-lagos');
    expect(articleSlug('!!!')).toBe('article');
  });
});
