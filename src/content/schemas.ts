import { z } from "zod";

/**
 * Website content documents. Everything is typed data — there is no raw HTML or
 * script anywhere, so an editor can't publish markup that breaks or attacks the site.
 * Section types match the page editor in Figma (AD-WEB-02).
 */

const text = (max: number) => z.string().trim().max(max);
const id = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9-]{1,80}$/);

/** Where a button or menu item points. Resolved to a path when content is delivered. */
export const linkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), key: z.string().regex(/^[a-z0-9-]{1,60}$/) }).strict(),
  z.object({ kind: z.literal("category"), slug }).strict(),
  z.object({ kind: z.literal("product"), slug }).strict(),
  z
    .object({
      kind: z.literal("path"),
      path: z
        .string()
        .regex(/^\/[A-Za-z0-9/_\-?=&#.%]*$/)
        .max(300),
    })
    .strict(),
  z
    .object({
      kind: z.literal("url"),
      url: z
        .string()
        .url()
        .max(500)
        .refine((u) => /^https:\/\//.test(u), "Use an https:// address"),
    })
    .strict(),
]);
export type Link = z.infer<typeof linkSchema>;

const cta = z.object({ label: text(40).min(1), link: linkSchema }).strict();
/**
 * Visual editor style presets (AD-WEB-09, D-30). Each value maps to brand design tokens in the
 * storefront — there is no free-form colour, size or CSS. Omitted values use the section's own design.
 */
export const sectionStyleSchema = z
  .object({
    background: z.enum(["white", "paper", "brandTint", "navy"]).optional(),
    spacing: z.enum(["compact", "standard", "spacious"]).optional(),
    width: z.enum(["contained", "full"]).optional(),
    align: z.enum(["start", "center"]).optional(),
    imageSide: z.enum(["start", "end"]).optional(),
  })
  .strict();
export type SectionStyle = z.infer<typeof sectionStyleSchema>;

/** Per-device visibility (AD-WEB-10). Hiding on every device is the same as `visible: false`. */
export const sectionDevicesSchema = z
  .object({ desktop: z.boolean().default(true), tablet: z.boolean().default(true), mobile: z.boolean().default(true) })
  .strict();

const blockBase = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  visible: z.boolean().default(true),
  style: sectionStyleSchema.optional(),
  devices: sectionDevicesSchema.optional(),
};

/** Rich text as structured nodes — headings, paragraphs and lists. */
const richNode = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), text: text(160).min(1) }).strict(),
  z.object({ type: z.literal("paragraph"), text: text(4000).min(1) }).strict(),
  z.object({ type: z.literal("list"), items: z.array(text(500).min(1)).min(1).max(30) }).strict(),
]);

export const blockSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...blockBase,
      type: z.literal("hero"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      body: text(400).optional(),
      points: z.array(text(80).min(1)).max(5).default([]),
      primary: cta.optional(),
      secondary: cta.optional(),
      imageId: id.optional(),
      note: text(160).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("assuranceStrip"),
      items: z
        .array(
          z
            .object({
              icon: z.enum(["tag", "eye", "truck", "receipt", "shield", "clock"]),
              title: text(60).min(1),
              detail: text(120),
            })
            .strict(),
        )
        .min(1)
        .max(6),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("categoryTiles"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      categorySlugs: z.array(slug).min(1).max(12),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("productCarousel"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      lead: text(300).optional(),
      productSlugs: z.array(slug).min(1).max(24),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("priceEstimator"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      lead: text(300).optional(),
      points: z.array(text(100).min(1)).max(5).default([]),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("steps"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      steps: z
        .array(z.object({ title: text(80).min(1), detail: text(300) }).strict())
        .min(1)
        .max(8),
      cta: cta.optional(),
      imageId: id.optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("ctaBand"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      body: text(400).optional(),
      points: z.array(text(100).min(1)).max(5).default([]),
      primary: cta.optional(),
      secondary: cta.optional(),
      imageId: id.optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("imageGallery"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      lead: text(300).optional(),
      images: z
        .array(z.object({ imageId: id, caption: text(120).optional() }).strict())
        .min(1)
        .max(12),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("faqList"),
      overline: text(80).optional(),
      heading: text(120).min(1),
      /** "homepage" = questions flagged for the homepage; or a topic key; or explicit ids. */
      source: z.union([
        z.literal("homepage"),
        z.object({ topicKey: z.string().max(60) }).strict(),
        z.object({ itemIds: z.array(id).min(1).max(20) }).strict(),
      ]),
      cta: cta.optional(),
    })
    .strict(),
  z.object({ ...blockBase, type: z.literal("richText"), nodes: z.array(richNode).min(1).max(100) }).strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("imageText"),
      heading: text(120).min(1),
      body: text(1500),
      imageId: id,
      imageSide: z.enum(["left", "right"]).default("right"),
      cta: cta.optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("cards"),
      heading: text(120).optional(),
      cards: z
        .array(
          z
            .object({
              icon: z
                .string()
                .regex(/^[a-z-]{1,30}$/)
                .optional(),
              title: text(80).min(1),
              body: text(400),
            })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("notice"),
      tone: z.enum(["info", "success", "warning", "error"]),
      title: text(120).min(1),
      body: text(600).optional(),
    })
    .strict(),
]);
export type Block = z.infer<typeof blockSchema>;

export const seoSchema = z
  .object({
    title: text(70).optional(),
    description: text(170).optional(),
    socialImageId: id.optional(),
    noindex: z.boolean().default(false),
  })
  .strict();

export const pageDocumentSchema = z
  .object({
    title: text(120).min(1),
    lead: text(400).optional(),
    overline: text(80).optional(),
    seo: seoSchema.default({ noindex: false }),
    blocks: z.array(blockSchema).max(40),
  })
  .strict()
  .refine((doc) => new Set(doc.blocks.map((b) => b.id)).size === doc.blocks.length, {
    message: "Section ids must be unique",
    path: ["blocks"],
  });
export type PageDocument = z.infer<typeof pageDocumentSchema>;

// ------------------------------------------------------------------ navigation

const navLink = z
  .object({
    label: text(60).min(1),
    link: linkSchema,
    newTab: z.boolean().default(false),
    mobile: z.boolean().default(true),
  })
  .strict();
export const navigationSchemas = {
  utility: z.object({ links: z.array(navLink).max(10) }).strict(),
  categoryBar: z.object({ categorySlugs: z.array(slug).max(12), quote: navLink.optional() }).strict(),
  footer: z
    .object({ columns: z.array(z.object({ title: text(40).min(1), links: z.array(navLink).max(15) }).strict()).max(6) })
    .strict(),
} as const;
export type MenuKey = keyof typeof navigationSchemas;
export const MENU_KEYS = Object.keys(navigationSchemas) as MenuKey[];

// --------------------------------------------------------------- site settings

export const siteSettingsSchema = z
  .object({
    brand: z.object({ name: text(60).min(1), tagline: text(120), logoImageId: id.optional() }).strict(),
    contact: z
      .object({
        phone: text(30).min(1),
        phoneHref: z.string().regex(/^tel:\+?[0-9]{6,15}$/),
        hours: text(80).min(1),
        supportEmail: z.string().email().max(254).nullable(),
      })
      .strict(),
    announcement: z
      .object({
        enabled: z.boolean(),
        message: text(140),
        link: linkSchema.optional(),
        startsAt: z.string().datetime().nullable(),
        endsAt: z.string().datetime().nullable(),
      })
      .strict(),
    seo: z
      .object({
        titleTemplate: text(60).regex(/%s/, "Include %s where the page title goes"),
        description: text(170),
        socialImageId: id.optional(),
      })
      .strict(),
  })
  .strict();
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
