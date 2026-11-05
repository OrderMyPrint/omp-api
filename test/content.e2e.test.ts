import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/setup";
import { nextCode, signedInStaff, type Signed } from "./helpers";

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
const prisma = new PrismaClient();
let editor: Signed;
let homeId: string;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  editor = await signedInStaff(http, prisma, "content-editor", "content-editor");
  homeId = (await prisma.contentPage.findUniqueOrThrow({ where: { key: "home" } })).id;
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const put = (s: Signed, url: string, body: object) => s.agent.put(url).set("x-csrf-token", s.csrf).send(body);
const post = (s: Signed, url: string, body: object = {}) => s.agent.post(url).set("x-csrf-token", s.csrf).send(body);

describe("published content (storefront)", () => {
  it("serves the homepage with every section resolved", async () => {
    const res = await request(http).get("/api/v1/content/pages?path=/").expect(200);
    expect(res.headers["cache-control"]).toContain("s-maxage=60");
    const types = res.body.blocks.map((b: { type: string }) => b.type);
    expect(types).toEqual([
      "hero",
      "assuranceStrip",
      "categoryTiles",
      "productCarousel",
      "priceEstimator",
      "steps",
      "ctaBand",
      "imageGallery",
      "faqList",
    ]);
    const [hero, , tiles, carousel, , , , gallery, faq] = res.body.blocks;
    expect(hero).toMatchObject({
      heading: "Print that makes your brand look its best.",
      primary: { label: "Shop products", href: "/products" },
      image: { url: "/images/hero.png", width: 1152 },
    });
    expect(hero.image.alt).toMatch(/visiting cards/);
    expect(tiles.categories).toHaveLength(4);
    expect(carousel.products.map((p: { slug: string }) => p.slug)).toEqual([
      "visiting-cards",
      "stickers",
      "dtf-stickers",
      "corporate-t-shirts",
      "letter-pads",
      "envelopes",
      "brochures",
    ]);
    expect(carousel.products[0]).toMatchObject({ startingPrice: "399.00" });
    expect(gallery.images).toHaveLength(3);
    expect(faq.items.map((i: { question: string }) => i.question)).toContain("Do you provide GST invoices?");
    expect(faq.cta).toMatchObject({ href: "/help" });
    expect(res.body.seo).toMatchObject({
      title: "Order My Print — Custom printing online in India",
      socialImage: { url: "/images/hero.png" },
    });
  });

  it("serves navigation, site settings and FAQ", async () => {
    const nav = (await request(http).get("/api/v1/content/navigation").expect(200)).body;
    expect(nav.utility.map((l: { href: string }) => l.href)).toEqual([
      "/track",
      "/quote",
      "/help/artwork-guidelines",
      "/help",
    ]);
    expect(nav.categoryBar.categories).toHaveLength(4);
    expect(nav.categoryBar.quote).toMatchObject({ label: "Get a bulk quote", href: "/quote" });
    expect(nav.footer.map((c: { title: string }) => c.title)).toEqual(["Shop", "Help", "Company", "Policies"]);
    expect(nav.footer[0].links[0]).toMatchObject({ label: "Visiting Cards", href: "/products/visiting-cards" });
    const settings = (await request(http).get("/api/v1/content/site-settings").expect(200)).body;
    expect(settings).toMatchObject({
      contact: { phone: "+91 63561 61761", supportEmail: null },
      announcement: null,
      redirects: [],
    });
    const faq = (await request(http).get("/api/v1/content/faq").expect(200)).body;
    expect(faq).toHaveLength(6);
  });

  it("serves policy drafts with their notice, and 404s unknown pages", async () => {
    const refund = (await request(http).get("/api/v1/content/pages?path=/policies/refund-and-cancellation").expect(200))
      .body;
    expect(refund.blocks[0]).toMatchObject({ type: "notice", title: "Draft — awaiting legal review" });
    expect(refund.blocks[1].nodes[0]).toMatchObject({ type: "heading", text: "1. Scope" });
    expect((await request(http).get("/api/v1/content/pages?path=/nope").expect(404)).body.code).toBe("PAGE_NOT_FOUND");
    expect((await request(http).get("/api/v1/content/pages?path=/About").expect(400)).body.code).toBe(
      "REQUEST_INVALID",
    );
  });
});

describe("editing pages", () => {
  it("keeps drafts private until published, and restores earlier versions", async () => {
    const page = (await editor.agent.get(`/api/v1/admin/content/pages/${homeId}`).expect(200)).body;
    const original = page.document;
    const changed = structuredClone(original);
    changed.blocks[0].heading = "Print that gets you noticed.";
    await put(editor, `/api/v1/admin/content/pages/${homeId}/draft`, { document: changed }).expect(200);

    const live = (await request(http).get("/api/v1/content/pages?path=/").expect(200)).body;
    expect(live.blocks[0].heading).toBe("Print that makes your brand look its best.");
    const preview = (await editor.agent.get(`/api/v1/admin/content/pages/${homeId}/preview`).expect(200)).body;
    expect(preview.blocks[0].heading).toBe("Print that gets you noticed.");

    const published = (await post(editor, `/api/v1/admin/content/pages/${homeId}/publish`).expect(200)).body;
    expect(published.versions.map((v: { status: string }) => v.status)).toEqual(["PUBLISHED", "ARCHIVED"]);
    expect((await request(http).get("/api/v1/content/pages?path=/").expect(200)).body.blocks[0].heading).toBe(
      "Print that gets you noticed.",
    );

    const v1 = published.versions.find((v: { versionNo: number }) => v.versionNo === 1);
    await post(editor, `/api/v1/admin/content/pages/${homeId}/versions/${v1.id}/restore`).expect(200);
    await post(editor, `/api/v1/admin/content/pages/${homeId}/publish`).expect(200);
    expect((await request(http).get("/api/v1/content/pages?path=/").expect(200)).body.blocks[0].heading).toBe(
      "Print that makes your brand look its best.",
    );
    await expect(
      prisma.$executeRawUnsafe(`UPDATE content_page_versions SET document = '{}' WHERE status = 'ARCHIVED'`),
    ).rejects.toThrow(/cannot be edited/);
  });

  it("rejects unknown fields (no raw HTML) and blocks publishing broken references", async () => {
    const page = (await editor.agent.get(`/api/v1/admin/content/pages/${homeId}`).expect(200)).body;
    const html = structuredClone(page.document);
    html.blocks[0].html = "<script>alert(1)</script>";
    expect(
      (await put(editor, `/api/v1/admin/content/pages/${homeId}/draft`, { document: html }).expect(400)).body.code,
    ).toBe("REQUEST_INVALID");
    const js = structuredClone(page.document);
    js.blocks[0].primary.link = { kind: "url", url: "javascript:alert(1)" };
    expect(
      (await put(editor, `/api/v1/admin/content/pages/${homeId}/draft`, { document: js }).expect(400)).body.code,
    ).toBe("REQUEST_INVALID");

    const broken = structuredClone(page.document);
    broken.blocks[3].productSlugs = ["visiting-cards", "gold-plated-cards"];
    await put(editor, `/api/v1/admin/content/pages/${homeId}/draft`, { document: broken }).expect(200);
    const res = await post(editor, `/api/v1/admin/content/pages/${homeId}/publish`).expect(422);
    expect(res.body.code).toBe("REFERENCE_INVALID");
    expect(res.body.problems).toEqual(['Product "gold-plated-cards" doesn\'t exist or is hidden']);
    await put(editor, `/api/v1/admin/content/pages/${homeId}/draft`, { document: page.document }).expect(200);
  });

  it("creates a new page as a draft", async () => {
    const created = await post(editor, "/api/v1/admin/content/pages", {
      key: "corporate-gifting",
      path: "/corporate-gifting",
      title: "Corporate gifting",
      type: "LANDING",
    }).expect(201);
    expect(created.body).toMatchObject({ editing: "draft", versions: [{ status: "DRAFT" }] });
    await request(http).get("/api/v1/content/pages?path=/corporate-gifting").expect(404);
  });
});

describe("permissions", () => {
  it("keeps content admin away from roles without content permissions", async () => {
    const sales = await signedInStaff(http, prisma, "sales", "sales-content");
    expect((await sales.agent.get("/api/v1/admin/content/pages").expect(403)).body.missing).toEqual(["content.read"]);
  });

  it("lets a writer edit but not publish", async () => {
    const owner = await signedInStaff(http, prisma, "owner", "owner-content");
    await post(owner, "/api/v1/admin/auth/step-up", { code: nextCode(owner.secret) }).expect(200);
    const role = await post(owner, "/api/v1/admin/roles", {
      name: `Writer ${Date.now()}`,
      permissions: ["content.read", "content.write"],
    }).expect(201);
    const writer = await signedInStaff(http, prisma, role.body.key, "writer");
    const page = (await writer.agent.get(`/api/v1/admin/content/pages/${homeId}`).expect(200)).body;
    await put(writer, `/api/v1/admin/content/pages/${homeId}/draft`, { document: page.document }).expect(200);
    expect((await post(writer, `/api/v1/admin/content/pages/${homeId}/publish`).expect(403)).body.missing).toEqual([
      "content.publish",
    ]);
    const item = await prisma.faqItem.findFirstOrThrow();
    expect(
      (
        await writer.agent
          .patch(`/api/v1/admin/content/faq/items/${item.id}`)
          .set("x-csrf-token", writer.csrf)
          .send({ isPublished: false })
          .expect(403)
      ).body.code,
    ).toBe("FORBIDDEN");
    await writer.agent
      .patch(`/api/v1/admin/content/faq/items/${item.id}`)
      .set("x-csrf-token", writer.csrf)
      .send({ answer: item.answer })
      .expect(200);
  });
});

describe("media, settings and redirects", () => {
  it("protects images in use and requires alt text before publishing", async () => {
    const media = (await editor.agent.get("/api/v1/admin/content/media").expect(200)).body as {
      id: string;
      url: string;
      usedOn: string[];
    }[];
    const hero = media.find((m) => m.url === "/images/hero.png")!;
    expect(hero.usedOn).toEqual(expect.arrayContaining(["Home", "Site settings"]));
    expect(
      (await editor.agent.delete(`/api/v1/admin/content/media/${hero.id}`).set("x-csrf-token", editor.csrf).expect(409))
        .body.code,
    ).toBe("MEDIA_IN_USE");

    const banner = await post(editor, "/api/v1/admin/content/media", {
      url: "/images/new-banner.png",
      fileName: "new-banner.png",
      mimeType: "image/png",
      alt: "",
    }).expect(201);
    const about = await prisma.contentPage.findUniqueOrThrow({ where: { key: "about" } });
    const doc = (await editor.agent.get(`/api/v1/admin/content/pages/${about.id}`).expect(200)).body.document;
    doc.blocks[0].imageId = banner.body.id;
    await put(editor, `/api/v1/admin/content/pages/${about.id}/draft`, { document: doc }).expect(200);
    const blocked = await post(editor, `/api/v1/admin/content/pages/${about.id}/publish`).expect(422);
    expect(blocked.body.problems).toEqual(["Image new-banner.png needs alt text"]);
    await editor.agent
      .patch(`/api/v1/admin/content/media/${banner.body.id}`)
      .set("x-csrf-token", editor.csrf)
      .send({ alt: "Our pre-press desk" })
      .expect(200);
    await post(editor, `/api/v1/admin/content/pages/${about.id}/publish`).expect(200);
    const live = (await request(http).get("/api/v1/content/pages?path=/about").expect(200)).body;
    expect(live.blocks[0].image).toMatchObject({ url: "/images/new-banner.png", alt: "Our pre-press desk" });
  });

  it("publishes the announcement bar only when settings are published", async () => {
    const owner = await signedInStaff(http, prisma, "owner", "owner-settings");
    const current = (await owner.agent.get("/api/v1/admin/content/site-settings").expect(200)).body.draft;
    const draft = {
      ...current,
      announcement: { enabled: true, message: "Diwali orders: order by 25 Oct", startsAt: null, endsAt: null },
    };
    await put(owner, "/api/v1/admin/content/site-settings", { draft }).expect(200);
    expect((await request(http).get("/api/v1/content/site-settings").expect(200)).body.announcement).toBeNull();
    await post(owner, "/api/v1/admin/content/site-settings/publish").expect(200);
    expect((await request(http).get("/api/v1/content/site-settings").expect(200)).body.announcement).toMatchObject({
      message: "Diwali orders: order by 25 Oct",
    });
    const bad = { ...current, seo: { ...current.seo, titleTemplate: "No placeholder" } };
    expect((await put(owner, "/api/v1/admin/content/site-settings", { draft: bad }).expect(400)).body.code).toBe(
      "REQUEST_INVALID",
    );
  });

  it("manages redirects without loops or chains", async () => {
    const owner = await signedInStaff(http, prisma, "owner", "owner-redirects");
    await post(owner, "/api/v1/admin/content/redirects", {
      fromPath: "/visiting-card",
      toPath: "/products/visiting-cards",
    }).expect(201);
    expect(
      (
        await post(owner, "/api/v1/admin/content/redirects", { fromPath: "/cards", toPath: "/visiting-card" }).expect(
          400,
        )
      ).body.code,
    ).toBe("REDIRECT_CHAIN");
    expect(
      (await post(owner, "/api/v1/admin/content/redirects", { fromPath: "/x", toPath: "/x" }).expect(400)).body.code,
    ).toBe("REDIRECT_LOOP");
    const settings = (await request(http).get("/api/v1/content/site-settings").expect(200)).body;
    expect(settings.redirects).toEqual([
      { fromPath: "/visiting-card", toPath: "/products/visiting-cards", permanent: true },
    ]);
    expect(
      (
        await editor.agent
          .post("/api/v1/admin/content/redirects")
          .set("x-csrf-token", editor.csrf)
          .send({ fromPath: "/a", toPath: "/b" })
          .expect(403)
      ).body.missing,
    ).toEqual(["site_settings.write"]);
  });

  it("publishes menus and records content changes in the audit log", async () => {
    const owner = await signedInStaff(http, prisma, "owner", "owner-menus");
    const menus = (await owner.agent.get("/api/v1/admin/content/navigation").expect(200)).body as {
      key: string;
      draft: { links: unknown[] };
    }[];
    const utility = menus.find((m) => m.key === "utility")!;
    const draft = {
      links: [
        ...utility.draft.links,
        { label: "About us", link: { kind: "page", key: "about" }, newTab: false, mobile: true },
      ],
    };
    await put(owner, "/api/v1/admin/content/navigation/utility", { draft }).expect(200);
    await post(owner, "/api/v1/admin/content/navigation/publish").expect(200);
    const nav = (await request(http).get("/api/v1/content/navigation").expect(200)).body;
    expect(nav.utility.at(-1)).toMatchObject({ label: "About us", href: "/about" });
    const audit = (await owner.agent.get("/api/v1/admin/audit?limit=100").expect(200)).body.items.map(
      (i: { action: string }) => i.action,
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        "content.page_published",
        "navigation.published",
        "site_settings.published",
        "media.updated",
        "redirect.created",
      ]),
    );
  });
});
