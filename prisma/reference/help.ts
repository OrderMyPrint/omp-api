/**
 * Help-centre content. Every answer restates a rule recorded in the docs repo
 * (PRD, functional specification, decision register, Figma copy). Answers
 * about prices and delivery use the researched reference data the business
 * must confirm before launch (D-08); legal policies wait on D-09.
 */

export type Faq = { q: string; a: string };
export type FaqGroup = { id: string; title: string; items: Faq[] };

export const faqGroups: FaqGroup[] = [
  {
    id: "ordering",
    title: "Ordering & pricing",
    items: [
      {
        q: "How is my price calculated?",
        a: "Your price comes from the product, quantity and options you choose — paper, sides, finish and setup — plus GST. The configurator shows the full breakdown, and our server confirms the final price at checkout.",
      },
      {
        q: "Why does the price per piece drop when I order more?",
        a: "Every product has quantity tiers. The tier table on each product page shows the price per piece at each quantity and how much you save.",
      },
      {
        q: "Do I need an account to order?",
        a: "You sign in with your mobile number and a one-time password (OTP) — there is no password to remember. Your orders, invoices and artwork are kept in your account.",
      },
    ],
  },
  {
    id: "artwork",
    title: "Artwork & files",
    items: [
      {
        q: "Which file types can I upload?",
        a: "PDF (preferred), PNG, JPEG, SVG and CorelDRAW (CDR), up to 50 MB per file.",
      },
      {
        q: "Can I upload CorelDRAW (CDR) files?",
        a: "Yes. CDR files are reviewed manually by our pre-press team in CorelDRAW. Convert text to curves, save as CorelDRAW X7 or newer, and attach a PDF copy if you can — it helps us check your design faster.",
      },
      {
        q: "Do you check my artwork?",
        a: "Yes. Automatic checks catch problems such as a wrong file type, a damaged file or low resolution, and a person in pre-press reviews every file before printing.",
      },
      {
        q: "Can I upload artwork after checkout?",
        a: "Yes. Choose “Upload after checkout” on the product page and add your files from your account. Printing starts only once your artwork is uploaded and approved.",
      },
      {
        q: "What happens if my file needs changes?",
        a: "Our pre-press team tells you what needs fixing and asks you for a revised file before anything is printed.",
      },
    ],
  },
  {
    id: "production",
    title: "Production & delivery",
    items: [
      {
        q: "When does printing start?",
        a: "Printing starts once your payment is confirmed and our pre-press team has approved your artwork.",
      },
      {
        q: "How long does production take?",
        a: "Each product shows how many working days it takes to be ready to ship, counted from artwork approval. Delivery time is added on top.",
      },
      {
        q: "How do I track my order?",
        a: "Every stage — artwork review, printing, quality check, dispatch and delivery — shows in your account, with courier details once your order ships. You can also look up an order on the Track order page.",
      },
    ],
  },
  {
    id: "payments",
    title: "Payments & GST invoices",
    items: [
      {
        q: "How can I pay?",
        a: "UPI, debit and credit cards, net banking and wallets, through a secure payment gateway.",
      },
      {
        q: "Do you provide GST invoices?",
        a: "Yes. Every order comes with a GST invoice. Add your GSTIN at checkout to claim input tax credit.",
      },
    ],
  },
  {
    id: "bulk",
    title: "Bulk & corporate",
    items: [
      {
        q: "How do bulk quotations work?",
        a: "Send one request for several products. Our sales team prices it and may revise it with you. You can accept, decline or ask questions online, and an accepted quote becomes an order without re-keying.",
      },
      {
        q: "Do you offer credit terms?",
        a: "Credit terms are available for approved companies. Ask our sales team when you request a quotation.",
      },
    ],
  },
  {
    id: "returns",
    title: "Returns & reprints",
    items: [
      {
        q: "Can I return a printed order?",
        a: "Every product is printed to your specification, so made-to-order rules apply. If your order has a printing defect, transit damage or a mistake on our side, we reprint it or refund you.",
      },
      {
        q: "What if my delivery arrives damaged?",
        a: "Contact us with photos of the package and products as soon as possible after delivery and we will put it right.",
      },
    ],
  },
];

export const artworkRules: {
  icon: "file" | "layers" | "image" | "grid" | "printer" | "pen";
  title: string;
  detail: string;
}[] = [
  {
    icon: "file",
    title: "Accepted formats",
    detail: "PDF (preferred), PNG, JPEG, SVG and CorelDRAW CDR, up to 50 MB per file.",
  },
  {
    icon: "layers",
    title: "CorelDRAW (CDR)",
    detail:
      "Reviewed manually in CorelDRAW. Convert text to curves, save as CorelDRAW X7 or newer, and attach a PDF copy if you can.",
  },
  {
    icon: "image",
    title: "Resolution",
    detail: "Aim for 300 dpi at final size. We warn you about low resolution but never block your order.",
  },
  {
    icon: "grid",
    title: "Bleed & safe area",
    detail: "Add 3 mm bleed on each side and keep text 3 mm inside the trim.",
  },
  {
    icon: "printer",
    title: "Colour",
    detail: "Design in CMYK where possible. Screen colours (RGB) may look slightly different in print.",
  },
  { icon: "pen", title: "Fonts", detail: "Embed or outline fonts in PDF and CDR files." },
];

export type Policy = {
  slug: string;
  title: string;
  /** Draft text from the approved design; the business and its legal adviser must confirm it (D-09). */
  sections?: { heading: string; body: string }[];
};

export const policies: Policy[] = [
  { slug: "shipping", title: "Shipping policy" },
  {
    slug: "refund-and-cancellation",
    title: "Refund & cancellation policy",
    sections: [
      {
        heading: "Scope",
        body: "This policy applies to all orders placed on our website, including orders created from accepted quotations. Every product is printed to your specification, so made-to-order rules apply.",
      },
      {
        heading: "Cancellations",
        body: "You can cancel free of charge until your artwork is approved for production; the full amount is refunded. Once printing has started, the order can no longer be cancelled.",
      },
      {
        heading: "Reprints & refunds",
        body: "If your order has a printing defect, transit damage or a mistake on our side, we will reprint it or refund you. Refunds go to your original payment method. Errors already present in the approved artwork are not covered.",
      },
      {
        heading: "Damaged deliveries",
        body: "Report damaged or missing items soon after delivery, with photos of the package and products, and we will resolve it quickly.",
      },
      {
        heading: "How to contact us",
        body: "Call +91 63561 61761 (Mon–Sat, 10 am – 7 pm) or message us from your account.",
      },
    ],
  },
  { slug: "privacy", title: "Privacy policy" },
  { slug: "terms", title: "Terms of use" },
  { slug: "grievance-officer", title: "Grievance officer" },
];

export function getPolicy(slug: string): Policy | undefined {
  return policies.find((policy) => policy.slug === slug);
}
