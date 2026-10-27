import { Errors } from '../../common/api/app-error';

/**
 * The storefront home page's editable copy. Unlike the other pages it is not
 * one rich-text body but fields the landing page lays out itself: the "Why
 * Choose DOOAA?" heading and its four cards, then the FAQ.
 *
 * The four cards keep their ids (and so their icons and the photo spotlight);
 * only their wording is editable. FAQ items can be added, removed and reordered.
 */
export type HomeFeature = { id: string; title: string; description: string };
export type HomeFaqItem = { question: string; answer: string };
export type HomeSections = {
  whyChoose: { heading: string; subheading: string; features: HomeFeature[] };
  faq: { heading: string; subheading: string; items: HomeFaqItem[] };
};

export const HOME_SLUG = 'home';
export const HOME_FEATURE_IDS = ['escrow', 'products', 'secure', 'transparency'] as const;
export const HOME_FAQ_LIMIT = 12;

export function defaultHomeSections(): HomeSections {
  return {
    whyChoose: {
      heading: 'Why Choose DOOAA?',
      subheading: 'Built with trust and transparency at its core',
      features: [
        { id: 'escrow', title: 'Escrow Payment', description: 'Securely holds funds until all agreement terms are met' },
        { id: 'products', title: 'Used & New Products', description: 'Shop smart with our collection of new and used products' },
        { id: 'secure', title: 'Secure Transactions', description: 'Advanced security mechanisms protect every transaction' },
        { id: 'transparency', title: 'Full Transparency', description: 'Complete visibility into product history and seller ratings' },
      ],
    },
    faq: {
      heading: 'Frequently Asked Questions',
      subheading: 'Everything you need to know about buying and selling on DOOAA',
      items: [
        {
          question: 'How do I buy an item on DOOAA?',
          answer:
            'Open the listing and tap Chat Seller. Ask your questions, agree the price — you can send an offer right in the chat — and arrange payment and delivery or a meetup with the seller there.',
        },
        {
          question: 'Do I pay on the website?',
          answer:
            'Usually not: you settle with the seller directly. When DOOAA escrow is available, a Buy via Escrow button appears in the chat; DOOAA then holds your payment until you confirm the item arrived as described.',
        },
        {
          question: 'How do I know a seller can be trusted?',
          answer:
            'Look for the verified badge, which sellers earn by confirming their identity. Every store also shows its ratings and reviews from previous buyers. Meet in a public place and inspect the item before you pay.',
        },
        {
          question: 'How do I start selling?',
          answer:
            'Create an account, choose Sell Item and switch your account to a seller. List your item with clear photos and an honest description; once it is approved, buyers can find it and chat with you.',
        },
        {
          question: 'Can I sell used items on DOOAA?',
          answer:
            'Yes. DOOAA is built for both new and used products. Describe the condition honestly and add clear photos so buyers know exactly what they are getting.',
        },
      ],
    },
  };
}

function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw Errors.badRequest(`${field} cannot be empty.`, 'INVALID_HOME_CONTENT');
  if (trimmed.length > max) throw Errors.badRequest(`${field} must be ${max} characters or fewer.`, 'INVALID_HOME_CONTENT');
  return trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Checks and trims what the console sent, keeping only the known fields. */
export function parseHomeSections(input: unknown): HomeSections {
  const root = record(input);
  const why = record(root.whyChoose);
  const faq = record(root.faq);

  const features = Array.isArray(why.features) ? why.features.map(record) : [];
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  if (features.length !== HOME_FEATURE_IDS.length || HOME_FEATURE_IDS.some((id) => !byId.has(id))) {
    throw Errors.badRequest('The four "Why Choose DOOAA?" cards must all be present.', 'INVALID_HOME_CONTENT');
  }

  const items = Array.isArray(faq.items) ? faq.items.map(record) : [];
  if (items.length === 0) throw Errors.badRequest('Add at least one FAQ question.', 'INVALID_HOME_CONTENT');
  if (items.length > HOME_FAQ_LIMIT) throw Errors.badRequest(`The FAQ can hold up to ${HOME_FAQ_LIMIT} questions.`, 'INVALID_HOME_CONTENT');

  return {
    whyChoose: {
      heading: text(why.heading, 'The section heading', 80),
      subheading: text(why.subheading, 'The section subheading', 160),
      features: HOME_FEATURE_IDS.map((id) => {
        const feature = byId.get(id)!;
        return { id, title: text(feature.title, 'A card title', 40), description: text(feature.description, 'A card description', 140) };
      }),
    },
    faq: {
      heading: text(faq.heading, 'The FAQ heading', 80),
      subheading: text(faq.subheading, 'The FAQ subheading', 160),
      items: items.map((item, index) => ({
        question: text(item.question, `Question ${index + 1}`, 160),
        answer: text(item.answer, `The answer to question ${index + 1}`, 1000),
      })),
    },
  };
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The same copy as rich text, so history and anything reading `body` still see it. */
export function homeHtml(sections: HomeSections): string {
  const { whyChoose, faq } = sections;
  return [
    `<h2>${escape(whyChoose.heading)}</h2><p>${escape(whyChoose.subheading)}</p>`,
    ...whyChoose.features.map((feature) => `<h3>${escape(feature.title)}</h3><p>${escape(feature.description)}</p>`),
    `<h2>${escape(faq.heading)}</h2><p>${escape(faq.subheading)}</p>`,
    ...faq.items.map((item) => `<h3>${escape(item.question)}</h3><p>${escape(item.answer)}</p>`),
  ].join('\n');
}
