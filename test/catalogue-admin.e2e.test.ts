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
let owner: Signed;
let editor: Signed;
let sales: Signed;
let letterPadsId: string;
let originalPublishedId: string;

const BASE = "/api/v1/admin/catalogue";
const send = (s: Signed, method: "post" | "put" | "patch" | "delete", url: string, body: object = {}) =>
  s.agent[method](url).set("x-csrf-token", s.csrf).send(body);

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  owner = await signedInStaff(http, prisma, "owner", "owner-catalogue");
  editor = await signedInStaff(http, prisma, "content-editor", "editor-catalogue");
  sales = await signedInStaff(http, prisma, "sales", "sales-catalogue");
  const product = await prisma.product.findUniqueOrThrow({ where: { slug: "letter-pads" } });
  letterPadsId = product.id;
  originalPublishedId = (
    await prisma.pricingVersion.findFirstOrThrow({ where: { productId: product.id, status: "PUBLISHED" } })
  ).id;
});

afterAll(async () => {
  // Put the reference pricing back so other suites see the seed state.
  await prisma.pricingVersion.deleteMany({
    where: { productId: letterPadsId, id: { not: originalPublishedId }, status: { in: ["DRAFT", "PUBLISHED"] } },
  });
  await prisma.pricingVersion.update({
    where: { id: originalPublishedId },
    data: { status: "PUBLISHED", effectiveTo: null },
  });
  await app?.close();
  await prisma.$disconnect();
});

describe("categories", () => {
  it("lists every category with product counts", async () => {
    const res = await sales.agent.get(`${BASE}/categories`).expect(200);
    expect(res.body.filter((c: { slug: string }) => !c.slug.startsWith("test-"))).toHaveLength(4);
    expect(res.body[0]).toMatchObject({ slug: "business-stationery", productCount: 3, isVisible: true });
  });

  it("creates a hidden category; only catalogue.publish can show it", async () => {
    const slug = `test-${Date.now().toString(36)}`;
    const created = await send(editor, "post", `${BASE}/categories`, {
      slug,
      name: "Test category",
      summary: "Only for tests",
    }).expect(201);
    expect(created.body).toMatchObject({ slug, isVisible: false, productCount: 0 });
    await send(editor, "post", `${BASE}/categories`, { slug, name: "Again", summary: "x" }).expect(409);

    const denied = await send(editor, "patch", `${BASE}/categories/${created.body.id}`, { isVisible: true }).expect(
      403,
    );
    expect(denied.body.code).toBe("FORBIDDEN");
    await send(editor, "patch", `${BASE}/categories/${created.body.id}`, { name: "Renamed" }).expect(200);
    const shown = await send(owner, "patch", `${BASE}/categories/${created.body.id}`, { isVisible: true }).expect(200);
    expect(shown.body).toMatchObject({ name: "Renamed", isVisible: true });

    const ids = (await owner.agent.get(`${BASE}/categories`).expect(200)).body.map((c: { id: string }) => c.id);
    const reordered = await send(editor, "put", `${BASE}/categories/order`, {
      ids: [ids[ids.length - 1], ...ids.slice(0, -1)],
    }).expect(200);
    expect(reordered.body[0].slug).toBe(slug);
    await send(editor, "put", `${BASE}/categories/order`, { ids: ids.slice(1) }).expect(422);
    await send(editor, "put", `${BASE}/categories/order`, { ids }).expect(200);

    await send(editor, "delete", `${BASE}/categories/${created.body.id}`).expect(200);
    const audit = await prisma.auditLog.findMany({ where: { targetId: created.body.id }, orderBy: { at: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "catalogue.category_created",
        "catalogue.category_updated",
        "catalogue.category_deleted",
      ]),
    );
  });

  it("refuses to delete a category that has products", async () => {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: "marketing-print" } });
    const res = await send(owner, "delete", `${BASE}/categories/${category.id}`).expect(409);
    expect(res.body.code).toBe("CATEGORY_NOT_EMPTY");
  });

  it("keeps catalogue admin away from roles without catalogue permissions", async () => {
    const prepress = await signedInStaff(http, prisma, "production", "production-catalogue");
    expect((await prepress.agent.get(`${BASE}/products`).expect(403)).body.missing).toEqual(["catalogue.read"]);
    await send(sales, "patch", `${BASE}/products/${letterPadsId}`, { name: "Nope" }).expect(403);
  });
});

describe("products", () => {
  it("lists every product with pricing status and artwork slots", async () => {
    const res = await editor.agent.get(`${BASE}/products`).expect(200);
    expect(res.body.filter((p: { slug: string }) => !p.slug.startsWith("test-"))).toHaveLength(7);
    const pads = res.body.find((p: { slug: string }) => p.slug === "letter-pads");
    expect(pads).toMatchObject({ isVisible: true, draftVersionNo: null, category: { slug: "business-stationery" } });
    expect(pads.publishedVersionNo).toBeGreaterThanOrEqual(1);
    expect(pads.artworkSlots.length).toBeGreaterThan(0);
  });

  it("edits details, options and artwork slots (audited)", async () => {
    const detail = (await editor.agent.get(`${BASE}/products/${letterPadsId}`).expect(200)).body;
    expect(detail.optionGroups.length).toBeGreaterThan(0);
    const name = detail.name as string;

    const renamed = await send(editor, "patch", `${BASE}/products/${letterPadsId}`, {
      name: "Letter Pads (test)",
      turnaroundMinDays: 2,
      turnaroundMaxDays: 9,
    }).expect(200);
    expect(renamed.body).toMatchObject({ name: "Letter Pads (test)", turnaroundMaxDays: 9 });
    await send(editor, "patch", `${BASE}/products/${letterPadsId}`, {
      turnaroundMinDays: 10,
      turnaroundMaxDays: 3,
    }).expect(422);
    await send(editor, "patch", `${BASE}/products/${letterPadsId}`, {
      name,
      turnaroundMinDays: detail.turnaroundMinDays,
      turnaroundMaxDays: detail.turnaroundMaxDays,
    }).expect(200);

    const option = detail.optionGroups[0].options[0];
    const off = await send(editor, "patch", `${BASE}/options/${option.id}`, {
      isAvailable: false,
      unavailableReason: "Priced on quotation",
    }).expect(200);
    expect(off.body.optionGroups[0].options[0]).toMatchObject({
      isAvailable: false,
      unavailableReason: "Priced on quotation",
    });
    const on = await send(editor, "patch", `${BASE}/options/${option.id}`, { isAvailable: true }).expect(200);
    expect(on.body.optionGroups[0].options[0]).toMatchObject({ isAvailable: true, unavailableReason: null });

    const slot = detail.artworkSlots[0];
    const edited = await send(editor, "patch", `${BASE}/artwork-slots/${slot.id}`, {
      bleedMm: "2.5",
      acceptedTypes: ["pdf", "png"],
    }).expect(200);
    expect(edited.body.artworkSlots[0]).toMatchObject({ bleedMm: "2.5", acceptedTypes: ["pdf", "png"] });
    await send(editor, "patch", `${BASE}/artwork-slots/${slot.id}`, {
      bleedMm: slot.bleedMm,
      acceptedTypes: slot.acceptedTypes,
    }).expect(200);
    await send(editor, "patch", `${BASE}/artwork-slots/${slot.id}`, { bleedMm: "lots" }).expect(400);

    const actions = (await prisma.auditLog.findMany({ where: { actorId: editor.userId } })).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "catalogue.product_updated",
        "catalogue.option_updated",
        "catalogue.artwork_slot_updated",
      ]),
    );
  });

  it("needs catalogue.publish to hide or show a product", async () => {
    expect(
      (await send(editor, "patch", `${BASE}/products/${letterPadsId}`, { isVisible: false }).expect(403)).body.code,
    ).toBe("FORBIDDEN");
    await send(owner, "patch", `${BASE}/products/${letterPadsId}`, { isVisible: false }).expect(200);
    await request(http).get("/api/v1/catalogue/products/letter-pads").expect(404);
    await send(owner, "patch", `${BASE}/products/${letterPadsId}`, { isVisible: true }).expect(200);
    await request(http).get("/api/v1/catalogue/products/letter-pads").expect(200);
  });
});

describe("pricing versions", () => {
  let draftId: string;
  let doc: {
    source: string;
    tiers: { minQty: number; unitPrice: string }[];
    options: Record<string, unknown>;
    quoteFromQty?: number;
  };

  it("lists versions; only pricing.write can start a draft", async () => {
    const list = (await sales.agent.get(`${BASE}/products/${letterPadsId}/pricing`).expect(200)).body;
    expect(list.product.slug).toBe("letter-pads");
    expect(list.versions[0]).toMatchObject({ id: originalPublishedId, status: "PUBLISHED" });
    expect(list.versions[0].source).toMatch(/D-08/);
    expect(
      (await send(editor, "post", `${BASE}/products/${letterPadsId}/pricing/drafts`).expect(403)).body.missing,
    ).toEqual(["pricing.write"]);
  });

  it("creates one draft, copied from the published version", async () => {
    const res = await send(owner, "post", `${BASE}/products/${letterPadsId}/pricing/drafts`).expect(201);
    expect(res.body).toMatchObject({ status: "DRAFT", productId: letterPadsId });
    draftId = res.body.id;
    doc = res.body.document;
    const again = await send(owner, "post", `${BASE}/products/${letterPadsId}/pricing/drafts`).expect(409);
    expect(again.body).toMatchObject({ code: "DRAFT_EXISTS", versionId: draftId });
  });

  it("validates the document against the schema and the product", async () => {
    await send(owner, "put", `${BASE}/pricing/${draftId}`, { document: { ...doc, tiers: [] } }).expect(400);
    const unknown = await send(owner, "put", `${BASE}/pricing/${draftId}`, {
      document: { ...doc, options: { ...doc.options, nope: { x: { perUnit: "1.00" } } } },
    }).expect(422);
    expect(unknown.body.code).toBe("PRICING_INVALID");
    expect(unknown.body.problems[0]).toMatch(/unknown option group "nope"/);
  });

  it("saves a draft, diffs it and runs the test bench", async () => {
    const [first, ...rest] = doc.tiers;
    const raised = (Number(first.unitPrice) + 1).toFixed(2);
    const saved = await send(owner, "put", `${BASE}/pricing/${draftId}`, {
      document: { ...doc, tiers: [{ ...first, unitPrice: raised }, ...rest] },
      note: "Test: first tier +₹1",
    }).expect(200);
    expect(saved.body).toMatchObject({ note: "Test: first tier +₹1" });

    const diff = (await owner.agent.get(`${BASE}/pricing/${draftId}/diff`).expect(200)).body;
    expect(diff.against.id).toBe(originalPublishedId);
    const tierRow = diff.rows.find((r: { component: string }) => r.component === `tier.${first.minQty}`);
    expect(tierRow).toMatchObject({ after: raised });
    expect(tierRow.change).toMatch(/^\+/);
    expect(diff.rows.filter((r: { change: string | null }) => r.change).length).toBe(1);

    const product = (await request(http).get("/api/v1/catalogue/products/letter-pads").expect(200)).body;
    const selections = Object.fromEntries(
      product.optionGroups.map((g: { key: string; kind: string; defaults: string[] }) => [
        g.key,
        g.kind === "MULTISELECT" ? g.defaults : g.defaults[0],
      ]),
    );
    const config = { selections, quantity: product.quantity.minimum };
    const draftPrice = (await send(sales, "post", `${BASE}/pricing/${draftId}/test`, config).expect(200)).body;
    const livePrice = (await send(sales, "post", `${BASE}/pricing/${originalPublishedId}/test`, config).expect(200))
      .body;
    expect(draftPrice.valid).toBe(true);
    expect(draftPrice.unitPrice).not.toBe(livePrice.unitPrice);
    expect(Number(draftPrice.subtotal)).toBeGreaterThan(Number(livePrice.subtotal));
  });

  it("publishes with pricing.publish and a fresh code, archiving the old version", async () => {
    const denied = await send(owner, "post", `${BASE}/pricing/${draftId}/publish`).expect(403);
    expect(denied.body.code).toBe("STEP_UP_REQUIRED");
    await send(owner, "post", "/api/v1/admin/auth/step-up", { code: nextCode(owner.secret) }).expect(200);
    const published = (await send(owner, "post", `${BASE}/pricing/${draftId}/publish`).expect(200)).body;
    expect(published.versions[0]).toMatchObject({ id: draftId, status: "PUBLISHED", publishedBy: "owner-catalogue" });
    expect(published.versions[1]).toMatchObject({ id: originalPublishedId, status: "ARCHIVED" });
    expect(published.versions[1].effectiveTo).toBeTruthy();

    const live = (await request(http).get("/api/v1/catalogue/products/letter-pads").expect(200)).body;
    expect(live.pricingVersionId).toBe(draftId);
    await send(owner, "put", `${BASE}/pricing/${draftId}`, { document: doc }).expect(409);
  });

  it("discards a draft", async () => {
    const draft = await send(owner, "post", `${BASE}/products/${letterPadsId}/pricing/drafts`).expect(201);
    await send(owner, "delete", `${BASE}/pricing/${draft.body.id}`).expect(200);
    await owner.agent.get(`${BASE}/pricing/${draft.body.id}`).expect(404);
  });
});
