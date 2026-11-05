/**
 * Seeds website content with exactly what the storefront shows today
 * (copied from the storefront: prisma/reference/help.ts and site.ts, and the
 * homepage section copy), so switching the storefront to the API changes nothing
 * visually. Create-only: anything an editor has changed in admin is left alone.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { pageDocumentSchema, navigationSchemas, siteSettingsSchema, type PageDocument } from "../src/content/schemas";
import { artworkRules, faqGroups, policies } from "./reference/help";
import { footerNav, site, utilityNav } from "./reference/site";

const media: [string, number, number, number, string][] = [
  [
    "hero.png",
    1152,
    928,
    1531742,
    "Printed visiting cards, letterheads, envelopes and round stickers in a matching navy and magenta design",
  ],
  ["process.png", 1152, 928, 1511026, "A press operator checking a printed sheet against the approved proof"],
  [
    "bulk-kit.png",
    1264,
    848,
    1560056,
    "A branded corporate welcome kit with T-shirts, visiting cards, letterheads and stickers",
  ],
  ["idea-cafe.png", 1200, 896, 1806296, "Menus, cards and stickers for cafés"],
  ["idea-packaging.png", 1200, 896, 1606954, "Stickers and inserts for online brands"],
  ["idea-team.png", 1200, 896, 1779384, "Printed T-shirts for teams and events"],
  ["logo-compact.png", 800, 384, 62052, "Order My Print"],
  ["category-stationery.png", 1376, 768, 1261016, "Visiting cards, letter pads and envelopes"],
  ["category-marketing.png", 1376, 768, 1594676, "Brochures and stickers"],
  ["category-transfers.png", 1376, 768, 1595605, "DTF transfer gang sheets"],
  ["category-merchandise.png", 1376, 768, 1403331, "Printed corporate T-shirts"],
  ["product-visiting-cards.png", 1200, 896, 1371203, "Visiting cards printed by Order My Print"],
  ["product-letter-pads.png", 1200, 896, 1477458, "Letter pads printed by Order My Print"],
  ["product-envelopes.png", 1200, 896, 1418249, "Envelopes printed by Order My Print"],
  ["product-brochures.png", 1200, 896, 1579081, "Brochures printed by Order My Print"],
  ["product-stickers.png", 1200, 896, 1592334, "Stickers printed by Order My Print"],
  ["product-dtf-stickers.png", 1200, 896, 1828212, "DTF stickers printed by Order My Print"],
  ["product-corporate-t-shirts.png", 1200, 896, 1628927, "Corporate T-shirts printed by Order My Print"],
];

const homepageQuestions = [
  "How is my price calculated?",
  "Can I upload CorelDRAW (CDR) files?",
  "When does printing start?",
  "Do you provide GST invoices?",
];

export async function seedContent(prisma: PrismaClient) {
  // Media
  const mediaId = new Map<string, string>();
  for (const [file, width, height, sizeBytes, alt] of media) {
    const url = `/images/${file}`;
    const row =
      (await prisma.mediaAsset.findUnique({ where: { url } })) ??
      (await prisma.mediaAsset.create({
        data: { url, fileName: file, mimeType: "image/png", width, height, sizeBytes, alt },
      }));
    mediaId.set(file, row.id);
  }
  const img = (file: string) => mediaId.get(file)!;

  // FAQ
  for (const [sort, group] of faqGroups.entries()) {
    if (await prisma.faqTopic.findUnique({ where: { key: group.id } })) continue;
    await prisma.faqTopic.create({
      data: {
        key: group.id,
        title: group.title,
        sort,
        items: {
          create: group.items.map((item, i) => ({
            question: item.q,
            answer: item.a,
            sort: i,
            isPublished: true,
            showOnHomepage: homepageQuestions.includes(item.q),
          })),
        },
      },
    });
  }

  // Pages
  const pages: { key: string; path: string; type: "HOMEPAGE" | "CONTENT" | "SYSTEM" | "POLICY"; doc: PageDocument }[] =
    [
      {
        key: "home",
        path: "/",
        type: "HOMEPAGE",
        doc: {
          title: "Home",
          seo: {
            title: "Order My Print — Custom printing online in India",
            description: site.description,
            socialImageId: img("hero.png"),
            noindex: false,
          },
          blocks: [
            {
              id: "hero",
              type: "hero",
              visible: true,
              overline: "Premium & professional printing",
              heading: "Print that makes your brand look its best.",
              body: "Visiting cards, letter pads, envelopes, brochures, stickers, DTF transfers and corporate T-shirts — configured online with a transparent price before you order.",
              points: [
                "Instant, server-verified price preview",
                "Upload PDF, PNG, JPEG, SVG or CorelDRAW (CDR)",
                "Bulk & corporate quotations with GST invoices",
              ],
              primary: { label: "Shop products", link: { kind: "path", path: "/products" } },
              secondary: { label: "Get a bulk quote", link: { kind: "path", path: "/quote" } },
              imageId: img("hero.png"),
              note: "Every file is reviewed by our pre-press team before printing.",
            },
            {
              id: "assurance",
              type: "assuranceStrip",
              visible: true,
              items: [
                { icon: "tag", title: "Transparent pricing", detail: "Breakdown & GST shown before checkout" },
                { icon: "eye", title: "Pre-press review", detail: "Every file checked by a person" },
                { icon: "truck", title: "Track every stage", detail: "From artwork approval to delivery" },
                { icon: "receipt", title: "GST invoices", detail: "Add your GSTIN at checkout" },
              ],
            },
            {
              id: "categories",
              type: "categoryTiles",
              visible: true,
              overline: "Shop by category",
              heading: "Everything your business prints",
              categorySlugs: ["business-stationery", "marketing-print", "custom-transfers", "corporate-merchandise"],
            },
            {
              id: "popular",
              type: "productCarousel",
              visible: true,
              overline: "Popular now",
              heading: "Our most-ordered print products",
              lead: "The business essentials our customers reorder most — configure any of them in minutes.",
              productSlugs: [
                "visiting-cards",
                "stickers",
                "dtf-stickers",
                "corporate-t-shirts",
                "letter-pads",
                "envelopes",
                "brochures",
              ],
            },
            {
              id: "estimator",
              type: "priceEstimator",
              visible: true,
              overline: "No surprises",
              heading: "See your price before you order",
              lead: "Pick a product and quantity — our pricing engine shows the indicative price, quantity tiers and GST instantly.",
              points: [
                "Quantity tiers show where you save",
                "Price breakdown: paper, finish, setup, GST",
                "Final price confirmed by our server at checkout",
              ],
            },
            {
              id: "journey",
              type: "steps",
              visible: true,
              overline: "Your order journey",
              heading: "From your file to your doorstep",
              steps: [
                {
                  title: "Configure & upload",
                  detail: "Choose options, see the price, upload print-ready artwork now or after checkout.",
                },
                {
                  title: "Pre-press review",
                  detail: "Our team reviews every file. If anything needs fixing, we ask before printing.",
                },
                {
                  title: "Production & quality check",
                  detail: "Printed after payment and artwork approval, then checked against a QC list.",
                },
                {
                  title: "Dispatch & tracking",
                  detail: "Track each stage in your account, with courier details when shipped.",
                },
              ],
              cta: { label: "Start configuring", link: { kind: "path", path: "/products" } },
              imageId: img("process.png"),
            },
            {
              id: "bulk",
              type: "ctaBand",
              visible: true,
              overline: "Bulk & corporate",
              heading: "Ordering for your whole team?",
              body: "Send one request for several products. Our sales team prices it, revises it with you, and turns your accepted quote into an order — no re-keying.",
              points: [
                "Multi-item quotations with artwork",
                "Accept, decline or ask questions online",
                "Credit terms for approved companies",
              ],
              primary: { label: "Request a quote", link: { kind: "path", path: "/quote" } },
              secondary: { label: "How quotes work", link: { kind: "path", path: "/help" } },
              imageId: img("bulk-kit.png"),
            },
            {
              id: "ideas",
              type: "imageGallery",
              visible: true,
              overline: "Ideas & inspiration",
              heading: "Print ideas for every kind of business",
              lead: "Menus for cafés, stickers for online brands and uniforms for teams — see what custom printing can do for you.",
              images: [
                { imageId: img("idea-cafe.png"), caption: "Menus, cards and stickers for cafés" },
                { imageId: img("idea-packaging.png"), caption: "Stickers and inserts for online brands" },
                { imageId: img("idea-team.png"), caption: "Printed T-shirts for teams and events" },
              ],
            },
            {
              id: "faq",
              type: "faqList",
              visible: true,
              overline: "Help",
              heading: "Questions, answered",
              source: "homepage",
              cta: { label: "Visit the help centre", link: { kind: "page", key: "help" } },
            },
          ],
        },
      },
      {
        key: "about",
        path: "/about",
        type: "CONTENT",
        doc: {
          title: "About us",
          overline: "About us",
          lead: "Order My Print helps individuals, businesses and corporate teams across India order print online — with a clear price before you pay and a person checking every file.",
          seo: {
            description:
              "Order My Print — premium and professional printing for individuals, businesses and corporate teams across India.",
            noindex: false,
          },
          blocks: [
            {
              id: "how",
              type: "imageText",
              visible: true,
              heading: "How we work",
              body: "You configure your product online and see the price, quantity tiers and GST straight away. Our pre-press team reviews every file before printing, each order is checked against a quality list, and you can follow every stage until it reaches your door.",
              imageId: img("process.png"),
              imageSide: "right",
            },
            {
              id: "cta",
              type: "ctaBand",
              visible: true,
              heading: "Ready to print?",
              body: "Browse our products and configure yours in minutes.",
              points: [],
              primary: { label: "Shop products", link: { kind: "path", path: "/products" } },
            },
          ],
        },
      },
      {
        key: "help",
        path: "/help",
        type: "SYSTEM",
        doc: {
          title: "Frequently asked questions",
          overline: "Help centre",
          lead: "Answers about ordering, artwork, delivery, payments and bulk quotations.",
          seo: {
            title: "Help centre · FAQ",
            description:
              "Answers about ordering, pricing, artwork files, delivery, payments, GST invoices and bulk quotations.",
            noindex: false,
          },
          blocks: [
            {
              id: "contact",
              type: "ctaBand",
              visible: true,
              heading: "Still need help?",
              body: `Our team replies ${site.hours.replace("Mon–Sat", "Monday to Saturday")}.`,
              points: [],
              primary: { label: "Contact us", link: { kind: "page", key: "contact" } },
            },
          ],
        },
      },
      {
        key: "contact",
        path: "/help/contact",
        type: "SYSTEM",
        doc: {
          title: "Contact us",
          overline: "Help centre",
          lead: "Questions about an order, artwork or pricing? We're happy to help.",
          seo: { noindex: false },
          blocks: [],
        },
      },
      {
        key: "artwork-guidelines",
        path: "/help/artwork-guidelines",
        type: "CONTENT",
        doc: {
          title: "Get your files print-ready",
          overline: "Artwork guidelines",
          lead: "Follow these basics and our pre-press team can approve your artwork faster.",
          seo: {
            title: "Artwork guidelines",
            description:
              "File formats, CorelDRAW (CDR) tips, resolution, bleed, colour and fonts — get your files print-ready.",
            noindex: false,
          },
          blocks: [
            {
              id: "rules",
              type: "cards",
              visible: true,
              cards: artworkRules.map((r) => ({ icon: r.icon, title: r.title, body: r.detail })),
            },
            {
              id: "checks",
              type: "notice",
              visible: true,
              tone: "warning",
              title: "Basic checks are not a print-quality guarantee",
              body: "Automatic checks catch file problems such as wrong type, corruption or low resolution. A person in pre-press reviews every file before printing.",
            },
          ],
        },
      },
      ...policies.map((p) => ({
        key: `policy-${p.slug}`,
        path: `/policies/${p.slug}`,
        type: "POLICY" as const,
        doc: {
          title: p.title,
          overline: "Policy",
          seo: { noindex: false },
          blocks: [
            p.sections
              ? {
                  id: "status",
                  type: "notice" as const,
                  visible: true,
                  tone: "warning" as const,
                  title: "Draft — awaiting legal review",
                  body: "This wording is a draft and may change before we start taking orders online.",
                }
              : {
                  id: "status",
                  type: "notice" as const,
                  visible: true,
                  tone: "warning" as const,
                  title: "Being finalised",
                  body: "We are finalising this policy with our legal adviser and will publish it before we start taking orders online.",
                },
            ...(p.sections
              ? [
                  {
                    id: "body",
                    type: "richText" as const,
                    visible: true,
                    nodes: p.sections.flatMap((s, i) => [
                      { type: "heading" as const, text: `${i + 1}. ${s.heading}` },
                      { type: "paragraph" as const, text: s.body },
                    ]),
                  },
                ]
              : []),
          ],
        },
      })),
    ];

  for (const p of pages) {
    if (await prisma.contentPage.findUnique({ where: { key: p.key } })) continue;
    const document = pageDocumentSchema.parse(p.doc) as Prisma.InputJsonValue;
    await prisma.contentPage.create({
      data: {
        key: p.key,
        path: p.path,
        title: p.doc.title,
        type: p.type,
        versions: { create: { versionNo: 1, status: "PUBLISHED", document, publishedAt: new Date() } },
      },
    });
  }

  // Navigation
  const linkFor = (href: string) => {
    if (href.startsWith("/products/")) return { kind: "product" as const, slug: href.split("/")[2] };
    const page = pages.find((p) => p.path === href);
    return page ? { kind: "page" as const, key: page.key } : { kind: "path" as const, path: href };
  };
  const nav = (label: string, href: string) => ({ label, link: linkFor(href), newTab: false, mobile: true });
  const menus = {
    utility: navigationSchemas.utility.parse({ links: utilityNav.map((l) => nav(l.label, l.href)) }),
    categoryBar: navigationSchemas.categoryBar.parse({
      categorySlugs: ["business-stationery", "marketing-print", "custom-transfers", "corporate-merchandise"],
      quote: nav("Get a bulk quote", "/quote"),
    }),
    footer: navigationSchemas.footer.parse({
      columns: footerNav.map((c) => ({ title: c.title, links: c.links.map((l) => nav(l.label, l.href)) })),
    }),
  };
  for (const [key, doc] of Object.entries(menus)) {
    if (await prisma.navigationMenu.findUnique({ where: { key } })) continue;
    await prisma.navigationMenu.create({
      data: {
        key,
        draft: doc as Prisma.InputJsonValue,
        published: doc as Prisma.InputJsonValue,
        publishedAt: new Date(),
      },
    });
  }

  // Site settings
  if (!(await prisma.siteSettings.findUnique({ where: { id: "site" } }))) {
    const settings = siteSettingsSchema.parse({
      brand: { name: site.name, tagline: site.tagline, logoImageId: img("logo-compact.png") },
      contact: { phone: site.phone.display, phoneHref: site.phone.href, hours: site.hours, supportEmail: null },
      announcement: { enabled: false, message: "", startsAt: null, endsAt: null },
      seo: { titleTemplate: "%s · Order My Print", description: site.description, socialImageId: img("hero.png") },
    }) as Prisma.InputJsonValue;
    await prisma.siteSettings.create({
      data: { id: "site", draft: settings, published: settings, publishedAt: new Date() },
    });
  }
}
