/**
 * Site-wide configuration: brand details, contact and navigation.
 * Business facts come from the decision register (docs repo). Values the
 * business has not supplied yet (legal name, GSTIN, address) are not shown.
 */

export const site = {
  name: "Order My Print",
  tagline: "Premium & professional printing",
  description:
    "Visiting cards, letter pads, envelopes, brochures, stickers, DTF transfers and corporate T-shirts — configured online with a transparent price before you order.",
  phone: {
    display: "+91 63561 61761",
    href: "tel:+916356161761",
  },
  hours: "Mon–Sat, 10 am – 7 pm",
} as const;

export type NavLink = { label: string; href: string };

export const routes = {
  home: "/",
  products: "/products",
  product: (slug: string) => `/products/${slug}`,
  category: (slug: string) => `/category/${slug}`,
  quote: "/quote",
  track: "/track",
  signIn: "/sign-in",
  cart: "/cart",
  help: "/help",
  contact: "/help/contact",
  artworkGuidelines: "/help/artwork-guidelines",
  policy: (slug: string) => `/policies/${slug}`,
} as const;

export const utilityNav: NavLink[] = [
  { label: "Track order", href: routes.track },
  { label: "Bulk & corporate quotes", href: routes.quote },
  { label: "Artwork guidelines", href: routes.artworkGuidelines },
  { label: "Help centre", href: routes.help },
];

export const footerNav: { title: string; links: NavLink[] }[] = [
  {
    title: "Shop",
    links: [
      { label: "Visiting Cards", href: routes.product("visiting-cards") },
      { label: "Letter Pads", href: routes.product("letter-pads") },
      { label: "Envelopes", href: routes.product("envelopes") },
      { label: "Brochures", href: routes.product("brochures") },
      { label: "Stickers", href: routes.product("stickers") },
      { label: "DTF Stickers", href: routes.product("dtf-stickers") },
      { label: "Corporate T-Shirts", href: routes.product("corporate-t-shirts") },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Track your order", href: routes.track },
      { label: "Artwork guidelines", href: routes.artworkGuidelines },
      { label: "FAQ", href: routes.help },
      { label: "Contact us", href: routes.contact },
      { label: "Bulk & corporate quotes", href: routes.quote },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About us", href: "/about" },
      { label: "Contact", href: routes.contact },
    ],
  },
  {
    title: "Policies",
    links: [
      { label: "Shipping policy", href: routes.policy("shipping") },
      { label: "Refund & cancellation", href: routes.policy("refund-and-cancellation") },
      { label: "Privacy policy", href: routes.policy("privacy") },
      { label: "Terms of use", href: routes.policy("terms") },
      { label: "Grievance officer", href: routes.policy("grievance-officer") },
    ],
  },
];
