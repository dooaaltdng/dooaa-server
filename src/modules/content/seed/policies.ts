/**
 * The storefront's policy pages, copied from dooaa-client (component/legal/
 * policies.ts) so the CMS starts with exactly the copy the client shipped.
 * After the first seed the CMS is the source of truth; edit pages in the
 * console, not here.
 */

export type PolicyBlock =
  | { type: "p"; text: string }
  /** Lettered sub-heading inside a section, e.g. "a. Personal Information". */
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: (string | { text: string; sub: string[] })[] }
  | { type: "contact"; email: string; address: string };

export type PolicySection = { heading: string; blocks: PolicyBlock[] };

export type Policy = {
  slug: string;
  /** Blue band heading and the line under it. */
  heroTitle: string;
  heroSubtitle: string;
  /** Used for <title> and the canonical description. */
  metaDescription: string;
  sections: PolicySection[];
};

export const REFUND_POLICY: Policy = {
  slug: "refund-policy",
  heroTitle: "Refund & Return Policy",
  heroSubtitle: "Refunds and returns are allowed for damaged or incorrect items after verification.",
  metaDescription:
    "When a DOOAA order can be refunded or returned, what evidence is needed, and how escrow decisions are made.",
  sections: [
    {
      heading: "DOOAA — Refund & Return Policy",
      blocks: [
        {
          type: "p",
          text: "At DOOAA, we aim to ensure a fair and secure experience for both buyers and sellers. This Refund Policy outlines the conditions under which refunds may be requested, approved, or denied on the DOOAA platform.",
        },
        { type: "p", text: "By using DOOAA, you agree to the terms described below." },
      ],
    },
    {
      heading: "Eligibility for Refund",
      blocks: [
        { type: "p", text: "Buyers may be eligible for a refund under the following conditions:" },
        {
          type: "ul",
          items: [
            "The item received is not as described by the seller.",
            "The item is damaged, defective, or incomplete.",
            "The seller fails to ship the item within the stated timeframe.",
            "The order is cancelled by the seller before shipment.",
            "The buyer cancels before the seller marks the order as “shipped.”",
          ],
        },
        {
          type: "p",
          text: "Refund eligibility is determined after DOOAA reviews the details submitted by both parties.",
        },
      ],
    },
    {
      heading: "Non-Refundable Situations",
      blocks: [
        { type: "p", text: "Refunds will not be issued in the following cases:" },
        {
          type: "ul",
          items: [
            "The buyer changes their mind after receiving the correct item.",
            "The buyer provides incorrect delivery information.",
            "Damage occurs due to improper handling after delivery.",
            "The buyer fails to provide required evidence during a dispute.",
            "Perishable or time-sensitive items after delivery (where applicable).",
          ],
        },
        {
          type: "p",
          text: "DOOAA may reject claims that lack sufficient evidence or violate platform policies.",
        },
      ],
    },
    {
      heading: "Refund Process",
      blocks: [
        { type: "p", text: "When a refund is requested:" },
        {
          type: "ol",
          items: [
            "The buyer must submit a refund request within the dispute window shown on the order page.",
            {
              text: "The buyer must provide relevant evidence such as:",
              sub: ["Photos or videos of the item", "Packaging details", "Explanation of the issue"],
            },
            "DOOAA reviews the case, may contact both parties, and may request additional proof.",
            "DOOAA makes a decision and issues the refund if approved.",
          ],
        },
        { type: "p", text: "Refunds are processed only through the original payment method." },
      ],
    },
    {
      heading: "Escrow Refunds",
      blocks: [
        { type: "p", text: "DOOAA uses an escrow system to protect buyers and sellers." },
        {
          type: "ul",
          items: [
            "If the buyer raises a dispute before funds are released, DOOAA may hold the payment until the issue is resolved.",
            "If the dispute is resolved in the buyer’s favor, the escrow amount is refunded.",
            "If the dispute is resolved in the seller’s favor, funds are released to the seller.",
          ],
        },
        { type: "p", text: "Escrow decisions are final and based on the evidence provided." },
      ],
    },
    {
      heading: "Order Cancellations",
      blocks: [
        { type: "p", text: "Buyer-Initiated Cancellation" },
        { type: "p", text: "You may cancel an order only if the seller has not shipped the item." },
        { type: "p", text: "Seller-Initiated Cancellation" },
        {
          type: "p",
          text: "If a seller cancels an order due to stock issues or other reasons, the buyer will automatically receive a full refund.",
        },
      ],
    },
    {
      heading: "Return Requirements",
      blocks: [
        { type: "p", text: "In cases where the item must be returned to the seller:" },
        {
          type: "ul",
          items: [
            "The buyer must return the item in its original condition.",
            "The buyer may be responsible for return shipping fees unless otherwise stated.",
            "Tracking information must be provided (if required).",
          ],
        },
        { type: "p", text: "Failure to return the item may affect refund eligibility." },
      ],
    },
    {
      heading: "Fraud and Abuse",
      blocks: [
        {
          type: "p",
          text: "DOOAA reserves the right to deny refunds and take action against users who:",
        },
        {
          type: "ul",
          items: [
            "Abuse the refund system",
            "Submit false or misleading claims",
            "Engage in fraudulent activity",
            "Repeatedly violate marketplace rules",
          ],
        },
        {
          type: "p",
          text: "Such actions may result in account suspension or permanent termination.",
        },
      ],
    },
    {
      heading: "Contact Us",
      blocks: [
        {
          type: "p",
          text: "If you have questions or concerns about this Privacy Policy, please contact:",
        },
        { type: "contact", email: "support@dooaa.com", address: "[Insert company address]" },
      ],
    },
  ],
};


export const SAFETY_TIPS: Policy = {
  slug: "safety-tips",
  heroTitle: "Safety Tips for Transactions",
  heroSubtitle:
    "Keep your transactions safe and reliable. These tips will help you trade confidently and avoid common risks on the platform.",
  metaDescription:
    "How to trade safely on DOOAA — keep conversations on-platform, pay through escrow, and spot the warning signs.",
  sections: [
    {
      heading: "Introduction",
      blocks: [
        {
          type: "p",
          text: "Your safety is our priority. DOOAA is built to support secure buying and selling, but we encourage all users to follow these guidelines to ensure smooth and protected transactions.",
        },
      ],
    },
    {
      heading: "Communicate Only Through DOOAA",
      blocks: [
        {
          type: "p",
          text: "Keep all conversations, negotiations, and agreements within the DOOAA platform.",
        },
        { type: "p", text: "This ensures:" },
        {
          type: "ul",
          items: [
            "Your chats are recorded for dispute resolution",
            "Your identity and data remain protected",
            "Reduced risk of fraudulent behavior",
          ],
        },
        { type: "p", text: "Avoid sharing personal contact details until absolutely necessary." },
      ],
    },
    {
      heading: "Use DOOAA\u2019s Secure Payment System",
      blocks: [
        {
          type: "p",
          text: "Always complete payments through DOOAA\u2019s escrow or approved payment channels.",
        },
        { type: "p", text: "Never send money:" },
        {
          type: "ul",
          items: [
            "Directly to a seller\u2019s bank account",
            "Through third-party links",
            "Through unverified platforms",
          ],
        },
        {
          type: "p",
          text: "Escrow protects both buyers and sellers by holding funds until the order is confirmed.",
        },
      ],
    },
    {
      heading: "Confirm Delivery and Condition",
      blocks: [
        { type: "p", text: "Before marking an order as received, buyers should:" },
        {
          type: "ul",
          items: [
            "Inspect the item thoroughly",
            "Ensure the product matches the description",
            "Report any issues immediately through DOOAA support",
          ],
        },
        { type: "p", text: "Sellers should ensure proper packaging to avoid damage during transit." },
      ],
    },
    {
      heading: "Avoid Sharing Sensitive Information",
      blocks: [
        { type: "p", text: "Do not share:" },
        {
          type: "ul",
          items: [
            "Passwords",
            "OTPs",
            "Bank login details",
            "Personal documents (except required verification through DOOAA)",
          ],
        },
        { type: "p", text: "Legitimate DOOAA staff will never ask for your password or OTP." },
      ],
    },
    {
      heading: "Beware of Unusual Requests",
      blocks: [
        { type: "p", text: "Be cautious if a buyer or seller:" },
        {
          type: "ul",
          items: [
            "Pressures you to complete a transaction outside the platform",
            "Offers deals that seem too good to be true",
            "Asks you to pay additional unverified fees",
            "Sends suspicious links or attachments",
          ],
        },
        { type: "p", text: "Report such behavior immediately." },
      ],
    },
    {
      heading: "Keep Proof of Everything",
      blocks: [
        { type: "p", text: "For your safety:" },
        {
          type: "ul",
          items: [
            "Keep receipts",
            "Save tracking numbers",
            "Record delivery evidence (photo or video)",
            "Document any unusual communication",
          ],
        },
        { type: "p", text: "This helps in case a dispute needs to be reviewed." },
      ],
    },
    {
      heading: "Use Reliable Delivery Services",
      blocks: [
        { type: "p", text: "Sellers should use trusted couriers with tracking services." },
        { type: "p", text: "Buyers should request tracking details to monitor their order." },
      ],
    },
    {
      heading: "Report Suspicious Activity",
      blocks: [
        { type: "p", text: "If you sense anything unusual:" },
        {
          type: "ul",
          items: [
            "Report the user immediately",
            "Contact DOOAA support via the Help Center",
            "Avoid completing the transaction until the issue is resolved",
          ],
        },
        { type: "p", text: "We actively monitor and take action to keep the platform safe." },
      ],
    },
    {
      heading: "Trust Your Instincts",
      blocks: [
        { type: "p", text: "If something doesn\u2019t feel right, pause and verify." },
        { type: "p", text: "Legitimate buyers and sellers respect secure processes." },
      ],
    },
    {
      heading: "Contact Us",
      blocks: [
        {
          type: "p",
          text: "If you have questions or concerns about this Privacy Policy, please contact:",
        },
        { type: "contact", email: "support@dooaa.com", address: "[Insert company address]" },
      ],
    },
  ],
};


/**
 * Three copy errors in the frame are corrected here: "anTy" → "any",
 * "DOOOA" → "DOOAA", and the Transaction section's lead-in, which repeats its
 * own heading ("You agree Transaction & Payment Terms").
 */
export const TERMS_POLICY: Policy = {
  slug: "terms",
  heroTitle: "Terms & Conditions",
  heroSubtitle:
    "Please review our Terms & Conditions to understand your rights and responsibilities on DOOAA.",
  metaDescription:
    "The terms that govern your use of the DOOAA marketplace — eligibility, marketplace rules, payments, shipping and disputes.",
  sections: [
    {
      heading: "Introduction",
      blocks: [
        {
          type: "p",
          text: "Welcome to DOOAA, an e-commerce platform that connects buyers and sellers for the purpose of listing, purchasing, and selling goods and services. By accessing or using DOOAA (\u201cthe Platform\u201d), you agree to abide by these Terms and Conditions. This includes browsing the website, creating an account, listing products, making purchases, or interacting with other users.",
        },
        {
          type: "p",
          text: "These Terms establish the rules, responsibilities, and rights that govern your use of the Platform. If you do not agree, you should stop using the Platform immediately.",
        },
      ],
    },
    {
      heading: "User Eligibility",
      blocks: [
        { type: "p", text: "To use DOOAA:" },
        {
          type: "ul",
          items: [
            "You must be at least 18 years old or have legal permission to participate in online transactions.",
            "You must provide accurate and up-to-date information when creating an account.",
            "You are responsible for maintaining the confidentiality of your login credentials.",
            "You agree not to create accounts on behalf of others without authorization.",
          ],
        },
        { type: "p", text: "DOOAA reserves the right to verify user information at any time." },
      ],
    },
    {
      heading: "Account Responsibilities",
      blocks: [
        { type: "p", text: "By creating an account, you agree to:" },
        {
          type: "ul",
          items: [
            "Provide truthful and complete information.",
            "Keep your password secure and confidential.",
            "Notify DOOAA immediately if you suspect unauthorized access.",
            "Use your account for lawful purposes only.",
            "Avoid sharing your account credentials with others.",
          ],
        },
        {
          type: "p",
          text: "Any activity conducted under your account is considered your responsibility.",
        },
      ],
    },
    {
      heading: "Marketplace Rules",
      blocks: [
        { type: "p", text: "When using DOOAA as a buyer or seller, you agree to:" },
        {
          type: "ul",
          items: [
            "Communicate honestly and respectfully.",
            "Provide accurate product information.",
            "Honor agreements made during transactions.",
            "Respond to messages and inquiries within a reasonable timeframe.",
            "Comply with local and international trade regulations.",
          ],
        },
        {
          type: "p",
          text: "DOOAA may intervene in conflicts but is not responsible for enforcing external private agreements.",
        },
      ],
    },
    {
      heading: "Prohibited Activities",
      blocks: [
        { type: "p", text: "You agree NOT to engage in any of the following:" },
        {
          type: "ul",
          items: [
            "Listing illegal, restricted, or counterfeit items.",
            "Scamming, deceiving, or exploiting users.",
            "Uploading harmful software, viruses, or malicious files.",
            "Sending spam, unsolicited communication, or harassment.",
            "Interfering with the platform\u2019s systems or security.",
            "Using automated tools (bots, scrapers) without permission.",
            "Misrepresenting your identity, product, or business.",
          ],
        },
        { type: "p", text: "Violation may result in account suspension or legal action." },
      ],
    },
    {
      heading: "Transaction & Payment Terms",
      blocks: [
        { type: "p", text: "You agree to the following:" },
        {
          type: "ul",
          items: [
            "Payments may be held in escrow until completion of a transaction.",
            "DOOAA is not responsible for bank failures, payment delays, or third-party processing issues.",
            "Buyers must confirm receipt of goods within the allotted time.",
            "Sellers must ship products on time and provide accurate tracking details.",
            "Refunds and cancellations follow DOOAA\u2019s dispute resolution process.",
          ],
        },
      ],
    },
    {
      heading: "Shipping & Delivery",
      blocks: [
        { type: "p", text: "Sellers are required to:" },
        {
          type: "ul",
          items: [
            "Ship items as described and within the stated timeframe.",
            "Use appropriate packaging and reliable delivery methods.",
            "Provide shipping evidence (tracking ID, receipt, etc.).",
          ],
        },
        { type: "p", text: "Buyers are required to:" },
        {
          type: "ul",
          items: [
            "Provide accurate delivery information.",
            "Be available to receive their items or arrange collection.",
          ],
        },
        {
          type: "p",
          text: "DOOAA is not responsible for delays caused by couriers, customs, or incorrect addresses.",
        },
      ],
    },
    {
      heading: "Intellectual Property Rights",
      blocks: [
        {
          type: "p",
          text: "All designs, graphics, software, branding elements, content, and materials on DOOAA are the exclusive property of DOOAA or its licensors. Users may not:",
        },
        {
          type: "ul",
          items: [
            "Copy, modify, distribute, or reproduce DOOAA content without permission.",
            "Use the DOOAA logo or brand for personal gain without authorization.",
            "Reverse-engineer platform features or underlying code.",
          ],
        },
        {
          type: "p",
          text: "User-generated content remains the property of the user, but by posting on DOOAA, you grant us a limited license to display and use this content for platform-related purposes.",
        },
      ],
    },
    {
      heading: "Dispute Resolution",
      blocks: [
        { type: "p", text: "If disagreements arise between buyers and sellers:" },
        {
          type: "ul",
          items: [
            "DOOAA may review evidence submitted by both parties.",
            "DOOAA may release funds, issue refunds, or take action based on its findings.",
            "DOOAA\u2019s decision may be final in platform-related disputes.",
          ],
        },
        { type: "p", text: "Users should maintain respectful communication throughout disputes." },
      ],
    },
    {
      heading: "Limitation of Liability",
      blocks: [
        { type: "p", text: "DOOAA is not liable for:" },
        {
          type: "ul",
          items: [
            "Losses due to third-party payment failures",
            "Courier or delivery issues",
            "User fraud or misrepresentation",
            "Business losses or profit expectations",
            "Downtime, platform maintenance, or technical errors",
          ],
        },
        { type: "p", text: "Users agree to use the platform at their own risk." },
      ],
    },
    {
      heading: "Contact Us",
      blocks: [
        {
          type: "p",
          text: "If you have questions or concerns about this Privacy Policy, please contact:",
        },
        { type: "contact", email: "support@dooaa.com", address: "[Insert company address]" },
      ],
    },
  ],
};


/**
 * Two paste errors in the frame:
 *
 * - The collection section is titled "Eligibility for Refund", copied from the
 *   refund page; it is titled "Information We Collect" here, which is what its
 *   body actually covers.
 * - A "Marketplace Rules" section is reproduced verbatim from the Terms page.
 *   It is kept as drawn, since dropping a whole section is the author's call —
 *   delete this entry if it was pasted by mistake.
 */
export const PRIVACY_POLICY: Policy = {
  slug: "privacy",
  heroTitle: "Privacy Policy",
  heroSubtitle:
    "We protect your personal information and use it only to support your activity on the platform.",
  metaDescription:
    "How DOOAA collects, uses, stores, shares and protects your personal information, and the rights you have over it.",
  sections: [
    {
      heading: "DOOAA — Privacy Policy",
      blocks: [
        {
          type: "p",
          text: "DOOAA is committed to protecting your privacy and ensuring the security of your personal information. This Privacy Policy explains how we collect, use, store, and protect your data when you access or use the DOOAA platform.",
        },
        { type: "p", text: "By using DOOAA, you agree to the practices described in this Privacy Policy." },
      ],
    },
    {
      heading: "Information We Collect",
      blocks: [
        {
          type: "p",
          text: "We may collect the following types of information when you create an account or use our services:",
        },
        { type: "h3", text: "a. Personal Information" },
        {
          type: "ul",
          items: [
            "Full name",
            "Phone number",
            "Email address",
            "Delivery address",
            "Government-issued ID (where verification is required)",
            "Payment details (processed securely by third-party providers)",
          ],
        },
        { type: "h3", text: "b. Transaction Information" },
        {
          type: "ul",
          items: [
            "Products purchased or sold",
            "Payment history",
            "Order status and delivery details",
            "Escrow records",
          ],
        },
        { type: "h3", text: "c. Technical Information" },
        {
          type: "ul",
          items: [
            "Device type",
            "IP address",
            "Browser type",
            "App usage data",
            "Cookies and tracking technologies",
          ],
        },
        { type: "h3", text: "d. User-Generated Content" },
        {
          type: "ul",
          items: [
            "Product listings",
            "Messages and chats",
            "Reviews and ratings",
            "Uploaded files (images, documents)",
          ],
        },
      ],
    },
    {
      heading: "How We Use Your Information",
      blocks: [
        { type: "p", text: "We use your information to:" },
        {
          type: "ul",
          items: [
            "Create and manage your DOOAA account",
            "Facilitate secure buying and selling transactions",
            "Process payments and manage escrow services",
            "Improve platform performance and user experience",
            "Prevent fraud, spam, and unauthorized activities",
            "Resolve disputes and provide customer support",
            "Personalize recommendations and listings",
            "Comply with legal and regulatory obligations",
          ],
        },
        { type: "p", text: "We only use your information for the purposes described above." },
      ],
    },
    {
      heading: "Marketplace Rules",
      blocks: [
        { type: "p", text: "When using DOOAA as a buyer or seller, you agree to:" },
        {
          type: "ul",
          items: [
            "Communicate honestly and respectfully.",
            "Provide accurate product information.",
            "Honor agreements made during transactions.",
            "Respond to messages and inquiries within a reasonable timeframe.",
            "Comply with local and international trade regulations.",
          ],
        },
        {
          type: "p",
          text: "DOOAA may intervene in conflicts but is not responsible for enforcing external private agreements.",
        },
      ],
    },
    {
      heading: "How We Protect Your Information",
      blocks: [
        {
          type: "p",
          text: "We use industry-standard security measures to safeguard your data, including:",
        },
        {
          type: "ul",
          items: [
            "Encrypted communications (HTTPS)",
            "Secure payment processing via trusted third-party gateways",
            "Access control and authentication",
            "Routine monitoring for suspicious activity",
            "Secure servers and data storage systems",
          ],
        },
        {
          type: "p",
          text: "Despite these measures, no system is 100% secure. Users are encouraged to protect their login details.",
        },
      ],
    },
    {
      heading: "How We Share Your Information",
      blocks: [
        {
          type: "p",
          text: "We do not sell your personal data to any third parties. However, we may share your information with:",
        },
        { type: "h3", text: "a. Trusted Service Providers" },
        {
          type: "ul",
          items: [
            "Payment processors",
            "Logistics and delivery partners",
            "Identity verification services",
            "Cloud hosting providers",
            "Customer support tools",
          ],
        },
        { type: "h3", text: "b. Legal Requirements" },
        { type: "p", text: "We may disclose your data if required to:" },
        {
          type: "ul",
          items: [
            "Comply with a legal obligation",
            "Respond to law enforcement requests",
            "Protect DOOAA\u2019s rights, safety, or property",
            "Prevent fraud or harmful activities",
          ],
        },
        { type: "h3", text: "c. Transaction Participants" },
        {
          type: "p",
          text: "Buyers and sellers may receive limited information necessary to complete transactions (e.g., delivery address, name, or contact number).",
        },
      ],
    },
    {
      heading: "Your Rights",
      blocks: [
        { type: "p", text: "Depending on your region, you may have the right to:" },
        {
          type: "ul",
          items: [
            "Access your personal information",
            "Update or correct your data",
            "Request deletion of your account and related data",
            "Withdraw consent for certain data usage",
            "Request a copy of your information",
          ],
        },
        { type: "p", text: "To exercise these rights, contact us at support@dooaa.com." },
      ],
    },
    {
      heading: "Children\u2019s Privacy",
      blocks: [
        { type: "p", text: "DOOAA is not intended for individuals under 18 years old." },
        {
          type: "p",
          text: "We do not knowingly collect data from minors. If we discover such data, it will be deleted promptly.",
        },
      ],
    },
    {
      heading: "Changes to This Policy",
      blocks: [
        {
          type: "p",
          text: "We may update this Privacy Policy periodically. When updated, the new version will be posted on the platform and the \u201cLast Updated\u201d date will be revised. Continued use of DOOAA indicates acceptance of the updated policy.",
        },
      ],
    },
    {
      heading: "Contact Us",
      blocks: [
        {
          type: "p",
          text: "If you have questions or concerns about this Privacy Policy, please contact:",
        },
        { type: "contact", email: "support@dooaa.com", address: "[Insert company address]" },
      ],
    },
  ],
};

export const POLICIES: Policy[] = [TERMS_POLICY, PRIVACY_POLICY, REFUND_POLICY, SAFETY_TIPS];

export function findPolicy(slug: string): Policy | undefined {
  return POLICIES.find((policy) => policy.slug === slug);
}
