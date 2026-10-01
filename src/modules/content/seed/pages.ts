import { POLICIES, type Policy, type PolicyBlock } from './policies';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function block(entry: PolicyBlock): string {
  switch (entry.type) {
    case 'p':
      return `<p>${escape(entry.text)}</p>`;
    case 'h3':
      return `<h3>${escape(entry.text)}</h3>`;
    case 'ul':
      return `<ul>${entry.items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${entry.items
        .map((item) =>
          typeof item === 'string'
            ? `<li>${escape(item)}</li>`
            : `<li>${escape(item.text)}<ul>${item.sub.map((sub) => `<li>${escape(sub)}</li>`).join('')}</ul></li>`,
        )
        .join('')}</ol>`;
    case 'contact':
      return `<p><strong>Email:</strong> <a href="mailto:${escape(entry.email)}">${escape(entry.email)}</a><br><strong>Address:</strong> ${escape(entry.address)}</p>`;
  }
}

/** Renders the client's structured policy into the CMS's rich text. */
export function policyHtml(policy: Policy): string {
  return policy.sections.map((section) => `<h2>${escape(section.heading)}</h2>${section.blocks.map(block).join('')}`).join('\n');
}

/** Admin slug ← the client's route segment. */
const POLICY_SLUG: Record<string, string> = {
  'terms-and-conditions': 'terms',
  terms: 'terms',
  privacy: 'privacy',
  'privacy-policy': 'privacy',
  'refund-policy': 'refunds',
  'safety-tips': 'safety',
};

export type SeedPage = { slug: string; title: string; summary: string; body: string; order: number };

export function defaultPages(): SeedPage[] {
  const policies = POLICIES.map((policy) => ({
    slug: POLICY_SLUG[policy.slug] ?? policy.slug,
    title: policy.heroTitle,
    summary: policy.heroSubtitle,
    body: policyHtml(policy),
  }));
  const bySlug = new Map(policies.map((page) => [page.slug, page]));
  const ordered: Omit<SeedPage, 'order'>[] = [
    {
      slug: 'about',
      title: 'About Us',
      summary: 'Learn more about our company and mission.',
      body: `<h2>About Us</h2>
<p>Welcome to DOOAA, a Nigerian marketplace that connects buyers and sellers of new and used goods. Every purchase can be held in escrow until the buyer confirms the item arrived as described, so both sides can trade with confidence.</p>
<p>Sellers reach buyers across the country, and buyers shop from verified sellers with clear ratings, honest descriptions and protected payments.</p>`,
    },
    {
      slug: 'help',
      title: 'Help Center',
      summary: 'Answers to the questions buyers and sellers ask most.',
      body: `<h2>Help Center</h2>
<p>Everything you need to run an account on DOOAA, in one place. Start with the section that matches what you are trying to do.</p>
<h3>Buying</h3>
<p>Every purchase is held in escrow until you confirm the item arrived as described. If it did not, open a dispute from the order and our moderation team will review both sides.</p>
<h3>Selling</h3>
<p>List an item, agree delivery with the buyer, and the funds are released to you once the buyer confirms receipt or the confirmation window closes.</p>
<h3>Account</h3>
<p>Verify your identity to earn the verified badge. High-value sellers are verified before their larger listings go live.</p>`,
    },
    bySlug.get('privacy')!,
    bySlug.get('terms')!,
    bySlug.get('refunds')!,
    bySlug.get('safety')!,
  ].filter(Boolean);
  return ordered.map((page, index) => ({ ...page, order: index + 1 }));
}
