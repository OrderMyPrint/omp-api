import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AuditService, type AuditContext } from "../auth/audit.service";
import type { StaffContext } from "../auth/auth.service";
import { CatalogueService } from "../catalogue/catalogue.service";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import {
  MENU_KEYS,
  navigationSchemas,
  pageDocumentSchema,
  siteSettingsSchema,
  type Block,
  type Link,
  type MenuKey,
  type PageDocument,
  type SiteSettings,
} from "./schemas";

type Refs = {
  media: Set<string>;
  products: Set<string>;
  categories: Set<string>;
  pages: Set<string>;
  faqItems: Set<string>;
  faqTopics: Set<string>;
};
const emptyRefs = (): Refs => ({
  media: new Set(),
  products: new Set(),
  categories: new Set(),
  pages: new Set(),
  faqItems: new Set(),
  faqTopics: new Set(),
});

/** Walks any content document and collects what it points at. */
function collectRefs(value: unknown, refs: Refs = emptyRefs()): Refs {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, refs));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.kind === "page" && typeof o.key === "string") refs.pages.add(o.key);
    if (o.kind === "category" && typeof o.slug === "string") refs.categories.add(o.slug);
    if (o.kind === "product" && typeof o.slug === "string") refs.products.add(o.slug);
    for (const [k, v] of Object.entries(o)) {
      if ((k === "imageId" || k === "socialImageId" || k === "logoImageId") && typeof v === "string") refs.media.add(v);
      else if (k === "productSlugs" && Array.isArray(v)) v.forEach((s) => refs.products.add(String(s)));
      else if (k === "categorySlugs" && Array.isArray(v)) v.forEach((s) => refs.categories.add(String(s)));
      else if (k === "itemIds" && Array.isArray(v)) v.forEach((s) => refs.faqItems.add(String(s)));
      else if (k === "topicKey" && typeof v === "string") refs.faqTopics.add(v);
      else collectRefs(v, refs);
    }
  }
  return refs;
}

type Lookup = Awaited<ReturnType<ContentService["lookup"]>>;

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: CatalogueService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- lookup

  /** Loads everything a set of documents refers to, in a few queries. */
  async lookup(refs: Refs, publishedPagesOnly: boolean) {
    const [media, pages, categories, products, faqItems, faqTopics] = await Promise.all([
      this.prisma.mediaAsset.findMany({ where: { id: { in: [...refs.media] } } }),
      this.prisma.contentPage.findMany({
        where: {
          key: { in: [...refs.pages] },
          ...(publishedPagesOnly ? { versions: { some: { status: "PUBLISHED" } } } : {}),
        },
        select: { key: true, path: true },
      }),
      refs.categories.size ? this.catalogue.categories() : Promise.resolve([]),
      refs.products.size ? this.catalogue.products({}) : Promise.resolve([]),
      this.prisma.faqItem.findMany({
        where: {
          OR: [
            { id: { in: [...refs.faqItems] } },
            { topic: { key: { in: [...refs.faqTopics] } } },
            { showOnHomepage: true },
          ],
          isPublished: true,
        },
        include: { topic: { select: { key: true } } },
        orderBy: [{ sort: "asc" }],
      }),
      this.prisma.faqTopic.findMany({ where: { key: { in: [...refs.faqTopics] } }, select: { key: true } }),
    ]);
    return {
      media: new Map(media.map((m) => [m.id, m])),
      pages: new Map(pages.map((p) => [p.key, p.path])),
      categories: new Map(categories.map((c) => [c.slug, c])),
      products: new Map(products.map((p) => [p.slug, p])),
      faqItems,
      faqTopics: new Set(faqTopics.map((t) => t.key)),
    };
  }

  /** Lists references that don't exist (or images without alt text). Publishing is blocked until fixed. */
  private async checkRefs(doc: unknown) {
    const problems = await this.findProblems(doc);
    if (problems.length)
      throw new ProblemException(422, "REFERENCE_INVALID", "Fix these before publishing", problems.join("; "), {
        problems,
      });
  }

  private async findProblems(doc: unknown) {
    const refs = collectRefs(doc);
    const l = await this.lookup(refs, false);
    const problems: string[] = [];
    for (const id of refs.media) {
      const m = l.media.get(id);
      if (!m) problems.push(`Image ${id} is not in the media library`);
      else if (!m.alt.trim()) problems.push(`Image ${m.fileName} needs alt text`);
    }
    for (const k of refs.pages) if (!l.pages.has(k)) problems.push(`Page "${k}" doesn't exist`);
    for (const s of refs.categories)
      if (!l.categories.has(s)) problems.push(`Category "${s}" doesn't exist or is hidden`);
    for (const s of refs.products) if (!l.products.has(s)) problems.push(`Product "${s}" doesn't exist or is hidden`);
    for (const t of refs.faqTopics) if (!l.faqTopics.has(t)) problems.push(`FAQ topic "${t}" doesn't exist`);
    for (const i of refs.faqItems)
      if (!l.faqItems.some((f) => f.id === i)) problems.push(`FAQ question ${i} doesn't exist or is unpublished`);
    return problems;
  }

  // ------------------------------------------------------------- resolving

  private link(link: Link | undefined, l: Lookup) {
    if (!link) return null;
    switch (link.kind) {
      case "page":
        return l.pages.has(link.key) ? { href: l.pages.get(link.key)!, external: false } : null;
      case "category":
        return l.categories.has(link.slug) ? { href: `/category/${link.slug}`, external: false } : null;
      case "product":
        return l.products.has(link.slug) ? { href: `/products/${link.slug}`, external: false } : null;
      case "path":
        return { href: link.path, external: false };
      case "url":
        return { href: link.url, external: true };
    }
  }

  private image(id: string | undefined, l: Lookup) {
    const m = id ? l.media.get(id) : undefined;
    return m ? { url: m.url, alt: m.alt, width: m.width, height: m.height } : null;
  }

  private cta(c: { label: string; link: Link } | undefined, l: Lookup) {
    const target = c ? this.link(c.link, l) : null;
    return c && target ? { label: c.label, ...target } : null;
  }

  private resolveBlock(b: Block, l: Lookup) {
    switch (b.type) {
      case "hero":
      case "ctaBand":
        return {
          ...b,
          primary: this.cta(b.primary, l),
          secondary: this.cta(b.secondary, l),
          image: this.image(b.imageId, l),
        };
      case "steps":
        return { ...b, cta: this.cta(b.cta, l), image: this.image(b.imageId, l) };
      case "imageText":
        return { ...b, cta: this.cta(b.cta, l), image: this.image(b.imageId, l) };
      case "categoryTiles":
        return { ...b, categories: b.categorySlugs.map((s) => l.categories.get(s)).filter(Boolean) };
      case "productCarousel":
        return { ...b, products: b.productSlugs.map((s) => l.products.get(s)).filter(Boolean) };
      case "imageGallery":
        return {
          ...b,
          images: b.images
            .map((i) => ({ caption: i.caption ?? null, image: this.image(i.imageId, l) }))
            .filter((i) => i.image),
        };
      case "faqList": {
        const src = b.source;
        const items =
          src === "homepage"
            ? l.faqItems.filter((f) => f.showOnHomepage)
            : "topicKey" in src
              ? l.faqItems.filter((f) => f.topic.key === src.topicKey)
              : src.itemIds
                  .map((id) => l.faqItems.find((f) => f.id === id))
                  .filter((f): f is (typeof l.faqItems)[number] => Boolean(f));
        return {
          ...b,
          cta: this.cta(b.cta, l),
          items: items.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
        };
      }
      default:
        return b;
    }
  }

  private async resolvePage(doc: PageDocument, publishedPagesOnly = true) {
    const l = await this.lookup(collectRefs(doc), publishedPagesOnly);
    return {
      title: doc.title,
      overline: doc.overline ?? null,
      lead: doc.lead ?? null,
      seo: { ...doc.seo, socialImage: this.image(doc.seo.socialImageId, l) },
      blocks: doc.blocks.filter((b) => b.visible !== false).map((b) => this.resolveBlock(b, l)),
    };
  }

  // ---------------------------------------------------------------- public

  async publishedPage(path: string) {
    const page = await this.prisma.contentPage.findUnique({
      where: { path },
      include: { versions: { where: { status: "PUBLISHED" }, take: 1 } },
    });
    const version = page?.versions[0];
    if (!page || !version) throw new ProblemException(404, "PAGE_NOT_FOUND", "Page not found");
    return {
      key: page.key,
      path: page.path,
      type: page.type,
      publishedAt: version.publishedAt,
      ...(await this.resolvePage(pageDocumentSchema.parse(version.document))),
    };
  }

  async publishedNavigation() {
    const menus = await this.prisma.navigationMenu.findMany();
    const docs = Object.fromEntries(menus.filter((m) => m.published).map((m) => [m.key, m.published]));
    const l = await this.lookup(collectRefs(docs), true);
    const links = (list: { label: string; link: Link; newTab: boolean; mobile: boolean }[]) =>
      list
        .map((i) => ({ label: i.label, newTab: i.newTab, mobile: i.mobile, target: this.link(i.link, l) }))
        .filter((i) => i.target)
        .map(({ target, ...i }) => ({ ...i, ...target! }));
    const utility = docs.utility ? navigationSchemas.utility.parse(docs.utility) : { links: [] };
    const bar = docs.categoryBar ? navigationSchemas.categoryBar.parse(docs.categoryBar) : { categorySlugs: [] };
    const footer = docs.footer ? navigationSchemas.footer.parse(docs.footer) : { columns: [] };
    return {
      utility: links(utility.links),
      categoryBar: {
        categories: bar.categorySlugs
          .map((s) => l.categories.get(s))
          .filter(Boolean)
          .map((c) => ({ slug: c!.slug, name: c!.name, href: `/category/${c!.slug}` })),
        quote: bar.quote ? (links([bar.quote])[0] ?? null) : null,
      },
      footer: footer.columns.map((c) => ({ title: c.title, links: links(c.links) })),
    };
  }

  async publishedSiteSettings() {
    const row = await this.prisma.siteSettings.findUnique({ where: { id: "site" } });
    if (!row?.published) throw new ProblemException(404, "SETTINGS_NOT_PUBLISHED", "Site settings not published yet");
    const s = siteSettingsSchema.parse(row.published);
    const l = await this.lookup(collectRefs(s), true);
    const now = Date.now();
    const a = s.announcement;
    const active =
      a.enabled &&
      a.message.trim() &&
      (!a.startsAt || Date.parse(a.startsAt) <= now) &&
      (!a.endsAt || Date.parse(a.endsAt) > now);
    return {
      brand: { name: s.brand.name, tagline: s.brand.tagline, logo: this.image(s.brand.logoImageId, l) },
      contact: s.contact,
      announcement: active ? { message: a.message, link: this.link(a.link, l) } : null,
      seo: {
        titleTemplate: s.seo.titleTemplate,
        description: s.seo.description,
        socialImage: this.image(s.seo.socialImageId, l),
      },
      redirects: await this.prisma.redirect.findMany({
        select: { fromPath: true, toPath: true, permanent: true },
        orderBy: { fromPath: "asc" },
      }),
    };
  }

  async publishedFaq() {
    const topics = await this.prisma.faqTopic.findMany({
      orderBy: { sort: "asc" },
      include: { items: { where: { isPublished: true }, orderBy: { sort: "asc" } } },
    });
    return topics.map((t) => ({
      key: t.key,
      title: t.title,
      items: t.items.map((i) => ({
        id: i.id,
        question: i.question,
        answer: i.answer,
        showOnHomepage: i.showOnHomepage,
      })),
    }));
  }

  // ----------------------------------------------------------------- pages

  async listPages() {
    const pages = await this.prisma.contentPage.findMany({
      orderBy: [{ type: "asc" }, { path: "asc" }],
      include: {
        versions: {
          where: { status: { in: ["DRAFT", "PUBLISHED"] } },
          select: { status: true, publishedAt: true, updatedAt: true },
        },
      },
    });
    return pages.map((p) => {
      const published = p.versions.find((v) => v.status === "PUBLISHED");
      const draft = p.versions.find((v) => v.status === "DRAFT");
      return {
        id: p.id,
        key: p.key,
        path: p.path,
        title: p.title,
        type: p.type,
        published: Boolean(published),
        publishedAt: published?.publishedAt ?? null,
        hasDraft: Boolean(draft),
        draftUpdatedAt: draft?.updatedAt ?? null,
      };
    });
  }

  async getPage(id: string) {
    const page = await this.prisma.contentPage.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNo: "desc" }, take: 30 } },
    });
    if (!page) throw new ProblemException(404, "PAGE_NOT_FOUND", "Page not found");
    const draft = page.versions.find((v) => v.status === "DRAFT");
    const published = page.versions.find((v) => v.status === "PUBLISHED");
    return {
      id: page.id,
      key: page.key,
      path: page.path,
      title: page.title,
      type: page.type,
      document: (draft ?? published)?.document ?? null,
      editing: draft ? "draft" : published ? "published" : "empty",
      versions: page.versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        createdAt: v.createdAt,
        publishedAt: v.publishedAt,
        publishedById: v.publishedById,
      })),
    };
  }

  async createPage(
    actor: StaffContext,
    input: { key: string; path: string; title: string; type: "CONTENT" | "LANDING" | "POLICY" },
    ctx: AuditContext,
  ) {
    if (await this.prisma.contentPage.findFirst({ where: { OR: [{ key: input.key }, { path: input.path }] } }))
      throw new ProblemException(409, "PAGE_EXISTS", "A page with this key or address already exists");
    const page = await this.prisma.contentPage.create({
      data: {
        key: input.key,
        path: input.path,
        title: input.title,
        type: input.type,
        versions: {
          create: {
            versionNo: 1,
            status: "DRAFT",
            document: { title: input.title, seo: { noindex: false }, blocks: [] },
            createdById: actor.user.id,
          },
        },
      },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "content.page_created",
      { type: "page", id: page.id },
      { after: input },
    );
    return this.getPage(page.id);
  }

  async saveDraft(actor: StaffContext, id: string, document: unknown, ctx: AuditContext) {
    const doc = pageDocumentSchema.parse(document);
    const page = await this.prisma.contentPage.findUnique({ where: { id } });
    if (!page) throw new ProblemException(404, "PAGE_NOT_FOUND", "Page not found");
    await this.prisma.$transaction(async (tx) => {
      const draft = await tx.contentPageVersion.findFirst({ where: { pageId: id, status: "DRAFT" } });
      if (draft)
        await tx.contentPageVersion.update({
          where: { id: draft.id },
          data: { document: doc as Prisma.InputJsonValue, createdById: actor.user.id },
        });
      else {
        const last = await tx.contentPageVersion.aggregate({ where: { pageId: id }, _max: { versionNo: true } });
        await tx.contentPageVersion.create({
          data: {
            pageId: id,
            versionNo: (last._max.versionNo ?? 0) + 1,
            status: "DRAFT",
            document: doc as Prisma.InputJsonValue,
            createdById: actor.user.id,
          },
        });
      }
      await tx.contentPage.update({ where: { id }, data: { title: doc.title } });
      // The visual editor autosaves every few seconds: audit one draft save per editor and page every 10 minutes.
      const recent = await tx.auditLog.findFirst({
        where: {
          action: "content.draft_saved",
          targetId: id,
          actorId: actor.user.id,
          at: { gt: new Date(Date.now() - 10 * 60_000) },
        },
        select: { id: true },
      });
      if (!recent)
        await this.audit.record(
          { ...ctx, actorId: actor.user.id },
          "content.draft_saved",
          { type: "page", id },
          undefined,
          tx,
        );
    });
    return this.getPage(id);
  }

  async publishPage(actor: StaffContext, id: string, ctx: AuditContext) {
    const draft = await this.prisma.contentPageVersion.findFirst({ where: { pageId: id, status: "DRAFT" } });
    if (!draft) throw new ProblemException(409, "NOTHING_TO_PUBLISH", "There are no unpublished changes");
    await this.checkRefs(pageDocumentSchema.parse(draft.document));
    await this.prisma.$transaction(async (tx) => {
      await tx.contentPageVersion.updateMany({
        where: { pageId: id, status: "PUBLISHED" },
        data: { status: "ARCHIVED" },
      });
      await tx.contentPageVersion.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: actor.user.id },
      });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "content.page_published",
        { type: "page", id },
        { after: { versionNo: draft.versionNo } },
        tx,
      );
    });
    return this.getPage(id);
  }

  async restoreVersion(actor: StaffContext, id: string, versionId: string, ctx: AuditContext) {
    const version = await this.prisma.contentPageVersion.findFirst({ where: { id: versionId, pageId: id } });
    if (!version) throw new ProblemException(404, "VERSION_NOT_FOUND", "Version not found");
    return this.saveDraft(actor, id, version.document, ctx);
  }

  /**
   * Visual editor canvas (AD-WEB-07…10): resolves an unsaved document exactly as the storefront
   * would show it, without saving. Hidden sections are left out, like on the live site.
   */
  async renderDocument(id: string, document: unknown) {
    const page = await this.prisma.contentPage.findUnique({ where: { id } });
    if (!page) throw new ProblemException(404, "PAGE_NOT_FOUND", "Page not found");
    return {
      key: page.key,
      path: page.path,
      type: page.type,
      ...(await this.resolvePage(pageDocumentSchema.parse(document), false)),
    };
  }

  /** Publish review (AD-WEB-11): what the draft changes compared with the live version, and what blocks publishing. */
  async review(id: string) {
    const versions = await this.prisma.contentPageVersion.findMany({
      where: { pageId: id, status: { in: ["DRAFT", "PUBLISHED"] } },
    });
    const draftRow = versions.find((v) => v.status === "DRAFT");
    if (!draftRow) throw new ProblemException(409, "NOTHING_TO_PUBLISH", "There are no unpublished changes");
    const draft = pageDocumentSchema.parse(draftRow.document);
    const liveRow = versions.find((v) => v.status === "PUBLISHED");
    const live = liveRow ? pageDocumentSchema.parse(liveRow.document) : null;
    const label = (b: Block) =>
      ("heading" in b && typeof b.heading === "string" && b.heading) ||
      ("title" in b && typeof b.title === "string" && b.title) ||
      b.type;
    const strip = (b: Block) => {
      const { visible: _v, style: _s, devices: _d, ...rest } = b;
      return JSON.stringify(rest);
    };
    const changes: { kind: string; blockId: string; type: string; label: string; detail?: string }[] = [];
    const before = new Map((live?.blocks ?? []).map((b, i) => [b.id, { b, i }]));
    const after = new Set(draft.blocks.map((b) => b.id));
    const liveOrder = (live?.blocks ?? []).filter((b) => after.has(b.id)).map((b) => b.id);
    const draftOrder = draft.blocks.filter((b) => before.has(b.id)).map((b) => b.id);
    draft.blocks.forEach((b) => {
      const old = before.get(b.id)?.b;
      const base = { blockId: b.id, type: b.type, label: label(b) };
      if (!old) return changes.push({ kind: "added", ...base });
      if (old.visible !== false && b.visible === false) changes.push({ kind: "hidden", ...base });
      else if (old.visible === false && b.visible !== false) changes.push({ kind: "shown", ...base });
      if (strip(old) !== strip(b)) changes.push({ kind: "edited", ...base });
      if (JSON.stringify(old.style ?? {}) !== JSON.stringify(b.style ?? {})) changes.push({ kind: "style", ...base });
      if (JSON.stringify(old.devices ?? {}) !== JSON.stringify(b.devices ?? {}))
        changes.push({ kind: "devices", ...base });
    });
    for (const { b } of before.values())
      if (!after.has(b.id)) changes.push({ kind: "removed", blockId: b.id, type: b.type, label: label(b) });
    if (liveOrder.join() !== draftOrder.join())
      changes.push({ kind: "reordered", blockId: "", type: "page", label: "Section order" });
    if (live && (live.title !== draft.title || JSON.stringify(live.seo) !== JSON.stringify(draft.seo)))
      changes.push({ kind: "edited", blockId: "", type: "page", label: "Page title & SEO" });
    return { firstPublish: !live, changes, problems: await this.findProblems(draft) };
  }

  async previewDraft(id: string) {
    const page = await this.getPage(id);
    if (!page.document) throw new ProblemException(404, "PAGE_EMPTY", "Nothing to preview");
    return {
      key: page.key,
      path: page.path,
      type: page.type,
      ...(await this.resolvePage(pageDocumentSchema.parse(page.document), false)),
    };
  }

  // ------------------------------------------------- navigation and settings

  async menus() {
    const rows = await this.prisma.navigationMenu.findMany({ orderBy: { key: "asc" } });
    return rows.map((r) => ({
      key: r.key,
      draft: r.draft,
      published: r.published,
      publishedAt: r.publishedAt,
      hasChanges: JSON.stringify(r.draft) !== JSON.stringify(r.published),
    }));
  }

  async saveMenu(actor: StaffContext, key: string, draft: unknown, ctx: AuditContext) {
    if (!MENU_KEYS.includes(key as MenuKey)) throw new ProblemException(404, "MENU_NOT_FOUND", "Menu not found");
    const doc = navigationSchemas[key as MenuKey].parse(draft);
    await this.prisma.navigationMenu.upsert({
      where: { key },
      update: { draft: doc as Prisma.InputJsonValue },
      create: { key, draft: doc as Prisma.InputJsonValue },
    });
    await this.audit.record({ ...ctx, actorId: actor.user.id }, "navigation.draft_saved", { type: "menu", id: key });
    return (await this.menus()).find((m) => m.key === key);
  }

  async publishMenus(actor: StaffContext, ctx: AuditContext) {
    const rows = await this.prisma.navigationMenu.findMany();
    await this.checkRefs(rows.map((r) => r.draft));
    await this.prisma.$transaction(
      rows.map((r) =>
        this.prisma.navigationMenu.update({
          where: { key: r.key },
          data: { published: r.draft as Prisma.InputJsonValue, publishedAt: new Date() },
        }),
      ),
    );
    await this.audit.record({ ...ctx, actorId: actor.user.id }, "navigation.published", { type: "menu", id: "all" });
    return this.menus();
  }

  async settings() {
    const row = await this.prisma.siteSettings.findUnique({ where: { id: "site" } });
    return { draft: row?.draft ?? null, published: row?.published ?? null, publishedAt: row?.publishedAt ?? null };
  }

  async saveSettings(actor: StaffContext, draft: unknown, ctx: AuditContext) {
    const doc: SiteSettings = siteSettingsSchema.parse(draft);
    await this.prisma.siteSettings.upsert({
      where: { id: "site" },
      update: { draft: doc as Prisma.InputJsonValue },
      create: { id: "site", draft: doc as Prisma.InputJsonValue },
    });
    await this.audit.record({ ...ctx, actorId: actor.user.id }, "site_settings.draft_saved", {
      type: "site_settings",
      id: "site",
    });
    return this.settings();
  }

  async publishSettings(actor: StaffContext, ctx: AuditContext) {
    const row = await this.prisma.siteSettings.findUnique({ where: { id: "site" } });
    if (!row) throw new ProblemException(409, "NOTHING_TO_PUBLISH", "Save the settings first");
    await this.checkRefs(row.draft);
    await this.prisma.siteSettings.update({
      where: { id: "site" },
      data: { published: row.draft as Prisma.InputJsonValue, publishedAt: new Date() },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "site_settings.published",
      { type: "site_settings", id: "site" },
      { before: row.published, after: row.draft },
    );
    return this.settings();
  }

  // ------------------------------------------------------------------- FAQ

  async faqAdmin() {
    return this.prisma.faqTopic.findMany({
      orderBy: { sort: "asc" },
      include: { items: { orderBy: { sort: "asc" } } },
    });
  }

  async createFaqTopic(actor: StaffContext, input: { key: string; title: string; sort?: number }, ctx: AuditContext) {
    if (await this.prisma.faqTopic.findUnique({ where: { key: input.key } }))
      throw new ProblemException(409, "TOPIC_EXISTS", "A topic with this key exists");
    const topic = await this.prisma.faqTopic.create({
      data: { key: input.key, title: input.title, sort: input.sort ?? 0 },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "faq.topic_created",
      { type: "faq_topic", id: topic.id },
      { after: input },
    );
    return topic;
  }

  async createFaqItem(
    actor: StaffContext,
    input: {
      topicId: string;
      question: string;
      answer: string;
      sort?: number;
      showOnHomepage?: boolean;
      isPublished?: boolean;
    },
    ctx: AuditContext,
  ) {
    if (!(await this.prisma.faqTopic.findUnique({ where: { id: input.topicId } })))
      throw new ProblemException(400, "TOPIC_NOT_FOUND", "Choose a valid topic");
    const item = await this.prisma.faqItem.create({ data: { ...input, isPublished: input.isPublished ?? false } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "faq.item_created",
      { type: "faq_item", id: item.id },
      { after: { question: item.question } },
    );
    return item;
  }

  async updateFaqItem(
    actor: StaffContext,
    id: string,
    input: Partial<{
      topicId: string;
      question: string;
      answer: string;
      sort: number;
      showOnHomepage: boolean;
      isPublished: boolean;
    }>,
    ctx: AuditContext,
  ) {
    const before = await this.prisma.faqItem.findUnique({ where: { id } });
    if (!before) throw new ProblemException(404, "FAQ_NOT_FOUND", "Question not found");
    const item = await this.prisma.faqItem.update({ where: { id }, data: input });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "faq.item_updated",
      { type: "faq_item", id },
      {
        before: { question: before.question, isPublished: before.isPublished },
        after: { question: item.question, isPublished: item.isPublished },
      },
    );
    return item;
  }

  async deleteFaqItem(actor: StaffContext, id: string, ctx: AuditContext) {
    await this.prisma.faqItem.delete({ where: { id } }).catch(() => {
      throw new ProblemException(404, "FAQ_NOT_FOUND", "Question not found");
    });
    await this.audit.record({ ...ctx, actorId: actor.user.id }, "faq.item_deleted", { type: "faq_item", id });
    return { deleted: true };
  }

  // ----------------------------------------------------------------- media

  /** Where each image is used (drafts and published pages, menus, settings). */
  private async mediaUsage() {
    const [versions, settings] = await Promise.all([
      this.prisma.contentPageVersion.findMany({
        where: { status: { in: ["DRAFT", "PUBLISHED"] } },
        include: { page: { select: { title: true } } },
      }),
      this.prisma.siteSettings.findUnique({ where: { id: "site" } }),
    ]);
    const usage = new Map<string, Set<string>>();
    const note = (refs: Refs, where: string) =>
      refs.media.forEach((id) => usage.set(id, (usage.get(id) ?? new Set()).add(where)));
    for (const v of versions) note(collectRefs(v.document), `${v.page.title}${v.status === "DRAFT" ? " (draft)" : ""}`);
    if (settings) note(collectRefs([settings.draft, settings.published]), "Site settings");
    return usage;
  }

  async media() {
    const [rows, usage] = await Promise.all([
      this.prisma.mediaAsset.findMany({ orderBy: { createdAt: "desc" } }),
      this.mediaUsage(),
    ]);
    return rows.map((m) => ({ ...m, usedOn: [...(usage.get(m.id) ?? [])] }));
  }

  async registerMedia(
    actor: StaffContext,
    input: { url: string; fileName: string; mimeType: string; width?: number; height?: number; alt: string },
    ctx: AuditContext,
  ) {
    if (await this.prisma.mediaAsset.findUnique({ where: { url: input.url } }))
      throw new ProblemException(409, "MEDIA_EXISTS", "This image is already in the library");
    const m = await this.prisma.mediaAsset.create({ data: input });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "media.registered",
      { type: "media", id: m.id },
      { after: { url: m.url } },
    );
    return m;
  }

  async updateMedia(actor: StaffContext, id: string, input: { alt: string }, ctx: AuditContext) {
    const before = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!before) throw new ProblemException(404, "MEDIA_NOT_FOUND", "Image not found");
    const m = await this.prisma.mediaAsset.update({ where: { id }, data: { alt: input.alt } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "media.updated",
      { type: "media", id },
      { before: { alt: before.alt }, after: { alt: m.alt } },
    );
    return m;
  }

  async deleteMedia(actor: StaffContext, id: string, ctx: AuditContext) {
    const used = (await this.mediaUsage()).get(id);
    if (used?.size)
      throw new ProblemException(409, "MEDIA_IN_USE", "Images in use can’t be deleted", [...used].join(", "));
    await this.prisma.mediaAsset.delete({ where: { id } }).catch(() => {
      throw new ProblemException(404, "MEDIA_NOT_FOUND", "Image not found");
    });
    await this.audit.record({ ...ctx, actorId: actor.user.id }, "media.deleted", { type: "media", id });
    return { deleted: true };
  }

  // ------------------------------------------------------------- redirects

  redirects() {
    return this.prisma.redirect.findMany({ orderBy: { fromPath: "asc" } });
  }

  async createRedirect(
    actor: StaffContext,
    input: { fromPath: string; toPath: string; permanent: boolean },
    ctx: AuditContext,
  ) {
    if (input.fromPath === input.toPath)
      throw new ProblemException(400, "REDIRECT_LOOP", "A redirect can’t point to itself");
    if (await this.prisma.redirect.findUnique({ where: { fromPath: input.fromPath } }))
      throw new ProblemException(409, "REDIRECT_EXISTS", "This address already redirects");
    if (await this.prisma.redirect.findUnique({ where: { fromPath: input.toPath } }))
      throw new ProblemException(400, "REDIRECT_CHAIN", "The target already redirects somewhere else");
    const r = await this.prisma.redirect.create({ data: input });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "redirect.created",
      { type: "redirect", id: r.id },
      { after: input },
    );
    return r;
  }

  async deleteRedirect(actor: StaffContext, id: string, ctx: AuditContext) {
    await this.prisma.redirect.delete({ where: { id } }).catch(() => {
      throw new ProblemException(404, "REDIRECT_NOT_FOUND", "Redirect not found");
    });
    await this.audit.record({ ...ctx, actorId: actor.user.id }, "redirect.deleted", { type: "redirect", id });
    return { deleted: true };
  }
}
