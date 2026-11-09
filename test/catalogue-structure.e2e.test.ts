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

const BASE = "/api/v1/admin/catalogue";
const send = (s: Signed, method: "post" | "put" | "patch" | "delete", url: string, body: object = {}) =>
  s.agent[method](url).set("x-csrf-token", s.csrf).send(body);

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  owner = await signedInStaff(http, prisma, "owner", "owner-structure");
  editor = await signedInStaff(http, prisma, "content-editor", "editor-structure");
});

afterAll(async () => {
  // Safety net if the slug test stopped half-way: put the seed slug back.
  await prisma.product.updateMany({ where: { slug: "letter-pads-renamed" }, data: { slug: "letter-pads" } });
  await prisma.optionRule.deleteMany({});
  await app?.close();
  await prisma.$disconnect();
});

describe("new products", () => {
  let id: string;
  let draftId: string;

  it("creates a hidden product with option groups, options, rules and a slot", async () => {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: "marketing-print" } });
    const tax = (await editor.agent.get(`${BASE}/tax-profiles`).expect(200)).body;
    expect(tax.length).toBeGreaterThan(0);
    const slug = `test-flyers-${Date.now().toString(36)}`;
    const created = await send(editor, "post", `${BASE}/products`, {
      slug,
      name: "Test flyers",
      categoryId: category.id,
      summary: "Only for tests",
      unitOne: "flyer",
      unitMany: "flyers",
      quantityMode: "TIERS",
      taxProfileId: tax[0].id,
      turnaroundMinDays: 2,
      turnaroundMaxDays: 4,
    }).expect(201);
    expect(created.body).toMatchObject({ slug, isVisible: false, optionGroups: [], artworkSlots: [], rules: [] });
    id = created.body.id;
    await send(editor, "post", `${BASE}/products`, { ...created.body, id: undefined }).expect(400);

    const withSize = await send(editor, "post", `${BASE}/products/${id}/option-groups`, {
      key: "size",
      label: "Choose size",
      hint: "Flat size",
      kind: "SELECT",
      required: true,
    }).expect(201);
    const sizeGroup = withSize.body.optionGroups[0];
    await send(editor, "post", `${BASE}/products/${id}/option-groups`, {
      key: "size",
      label: "Again",
      hint: "",
      kind: "SELECT",
      required: true,
    }).expect(409);
    await send(editor, "post", `${BASE}/option-groups/${sizeGroup.id}/options`, { key: "a5", label: "A5" }).expect(201);
    const a4 = await send(editor, "post", `${BASE}/option-groups/${sizeGroup.id}/options`, {
      key: "a4",
      label: "A4",
    }).expect(201);
    // The first option of a pick-one group becomes the default.
    expect(a4.body.optionGroups[0].defaultKeys).toEqual(["a5"]);

    const finish = await send(editor, "post", `${BASE}/products/${id}/option-groups`, {
      key: "finish",
      label: "Finish",
      hint: "",
      kind: "SELECT",
      required: true,
    }).expect(201);
    const finishGroup = finish.body.optionGroups[1];
    await send(editor, "post", `${BASE}/option-groups/${finishGroup.id}/options`, {
      key: "none",
      label: "None",
    }).expect(201);
    const withGloss = await send(editor, "post", `${BASE}/option-groups/${finishGroup.id}/options`, {
      key: "gloss",
      label: "Gloss",
    }).expect(201);

    // Reorder groups and options.
    const reordered = await send(editor, "put", `${BASE}/products/${id}/option-groups/order`, {
      ids: [finishGroup.id, sizeGroup.id],
    }).expect(200);
    expect(reordered.body.optionGroups.map((g: { key: string }) => g.key)).toEqual(["finish", "size"]);
    const opts = withGloss.body.optionGroups[1].options.map((o: { id: string }) => o.id);
    const flipped = await send(editor, "put", `${BASE}/option-groups/${finishGroup.id}/options/order`, {
      ids: [...opts].reverse(),
    }).expect(200);
    expect(flipped.body.optionGroups[0].options.map((o: { key: string }) => o.key)).toEqual(["gloss", "none"]);

    // Rules are validated against the product.
    const bad = await send(editor, "post", `${BASE}/products/${id}/rules`, {
      whenGroup: "finish",
      whenOption: "matte",
      effect: "EXCLUDES",
      thenGroup: "size",
      thenOptions: ["a4"],
      message: "x",
    }).expect(422);
    expect(bad.body.problems[0]).toMatch(/"matte" is not an option of Finish/);
    const ruled = await send(editor, "post", `${BASE}/products/${id}/rules`, {
      whenGroup: "finish",
      whenOption: "gloss",
      effect: "EXCLUDES",
      thenGroup: "size",
      thenOptions: ["a5"],
      message: "Gloss isn't available on A5.",
    }).expect(201);
    expect(ruled.body.rules).toHaveLength(1);

    const slot = await send(editor, "post", `${BASE}/products/${id}/artwork-slots`, {
      label: "Front",
      printArea: "Full page",
      bleedMm: "3",
    }).expect(201);
    expect(slot.body.artworkSlots[0]).toMatchObject({ key: "front", bleedMm: "3.0" });
  });

  it("refuses to delete options and groups that rules or pricing use", async () => {
    const product = (await editor.agent.get(`${BASE}/products/${id}`).expect(200)).body;
    const finish = product.optionGroups.find((g: { key: string }) => g.key === "finish");
    const gloss = finish.options.find((o: { key: string }) => o.key === "gloss");
    const inUse = await send(editor, "delete", `${BASE}/options/${gloss.id}`).expect(409);
    expect(inUse.body).toMatchObject({ code: "IN_USE" });
    expect(inUse.body.problems[0]).toMatch(/Gloss isn't available on A5/);
    await send(editor, "delete", `${BASE}/option-groups/${finish.id}`).expect(409);

    const none = finish.options.find((o: { key: string }) => o.key === "none");
    const afterDelete = await send(editor, "delete", `${BASE}/options/${none.id}`).expect(200);
    const left = afterDelete.body.optionGroups.find((g: { key: string }) => g.key === "finish");
    expect(left.options.map((o: { key: string }) => o.key)).toEqual(["gloss"]);
    expect(left.defaultKeys).toEqual([]);
    const last = await send(editor, "delete", `${BASE}/options/${gloss.id}`).expect(409);
    expect(last.body.code).toBe("LAST_OPTION");

    const fixed = await send(editor, "patch", `${BASE}/option-groups/${finish.id}`, {
      defaultKeys: ["gloss"],
      label: "Choose a finish",
    }).expect(200);
    expect(fixed.body.optionGroups[0]).toMatchObject({ label: "Choose a finish", defaultKeys: ["gloss"] });
    await send(editor, "patch", `${BASE}/option-groups/${finish.id}`, { defaultKeys: ["nope"] }).expect(422);
  });

  it("starts pricing from a template that must be filled before publishing", async () => {
    const draft = await send(owner, "post", `${BASE}/products/${id}/pricing/drafts`).expect(201);
    draftId = draft.body.id;
    expect(draft.body.document.tiers).toEqual([{ minQty: 1, unitPrice: "0.00" }]);
    await send(owner, "post", "/api/v1/admin/auth/step-up", { code: nextCode(owner.secret) }).expect(200);
    const zero = await send(owner, "post", `${BASE}/pricing/${draftId}/publish`).expect(422);
    expect(zero.body.problems[0]).toMatch(/0\.00/);

    await send(owner, "put", `${BASE}/pricing/${draftId}`, {
      document: {
        ...draft.body.document,
        source: "Test figures",
        tiers: [
          { minQty: 100, unitPrice: "2.00" },
          { minQty: 500, unitPrice: "1.50" },
        ],
      },
    }).expect(200);

    // The draft's test bench applies the product's rules.
    const blocked = await send(owner, "post", `${BASE}/pricing/${draftId}/test`, {
      selections: { finish: "gloss", size: "a5" },
      quantity: 100,
    }).expect(200);
    expect(blocked.body.valid).toBe(false);
    expect(blocked.body.errors).toEqual([
      { code: "CONSTRAINT_VIOLATION", field: "selections.size", message: "Gloss isn't available on A5." },
    ]);
    const ok = await send(owner, "post", `${BASE}/pricing/${draftId}/test`, {
      selections: { finish: "gloss", size: "a4" },
      quantity: 100,
    }).expect(200);
    expect(ok.body).toMatchObject({ valid: true, subtotal: "200.00" });
  });

  it("can't be shown until it has an image and published pricing", async () => {
    const noPricing = await send(owner, "patch", `${BASE}/products/${id}`, { isVisible: true }).expect(409);
    expect(noPricing.body.code).toBe("NO_PUBLISHED_PRICING");
    // The step-up from the previous test is still fresh.
    await send(owner, "post", `${BASE}/pricing/${draftId}/publish`, {}).expect(200);
    const noImage = await send(owner, "patch", `${BASE}/products/${id}`, { isVisible: true }).expect(409);
    expect(noImage.body.code).toBe("NO_IMAGE");
    await send(owner, "patch", `${BASE}/products/${id}`, { imageUrl: "javascript:alert(1)" }).expect(400);
    const shown = await send(owner, "patch", `${BASE}/products/${id}`, {
      imageUrl: "/images/hero.png",
      isVisible: true,
    }).expect(200);
    expect(shown.body.isVisible).toBe(true);

    const slug = shown.body.slug;
    const live = (await request(http).get(`/api/v1/catalogue/products/${slug}`).expect(200)).body;
    expect(live.rules).toHaveLength(1);
    const preview = await request(http)
      .post("/api/v1/pricing/preview")
      .send({ productSlug: slug, selections: { finish: "gloss", size: "a5" }, quantity: 100 })
      .expect(200);
    expect(preview.body.errors[0].code).toBe("CONSTRAINT_VIOLATION");
    await send(owner, "patch", `${BASE}/products/${id}`, { isVisible: false }).expect(200);
  });
});

describe("scheduled pricing", () => {
  it("schedules a version, refuses a second one, cancels and activates when due", async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug: "envelopes" } });
    const original = await prisma.pricingVersion.findFirstOrThrow({
      where: { productId: product.id, status: "PUBLISHED" },
    });
    const draft = await send(owner, "post", `${BASE}/products/${product.id}/pricing/drafts`).expect(201);
    // The step-up from the previous test is still fresh.
    const when = new Date(Date.now() + 3 * 24 * 3600_000);
    const scheduled = await send(owner, "post", `${BASE}/pricing/${draft.body.id}/publish`, {
      effectiveFrom: when.toISOString(),
    }).expect(200);
    expect(scheduled.body.versions[0]).toMatchObject({
      id: draft.body.id,
      status: "SCHEDULED",
      publishedBy: "owner-structure",
    });
    expect(new Date(scheduled.body.versions[0].effectiveFrom).getTime()).toBe(when.getTime());
    expect(scheduled.body.versions[1]).toMatchObject({ id: original.id, status: "PUBLISHED" });

    const second = await send(owner, "post", `${BASE}/products/${product.id}/pricing/drafts`).expect(409);
    expect(second.body.code).toBe("VERSION_SCHEDULED");
    await send(owner, "put", `${BASE}/pricing/${draft.body.id}`, { document: draft.body.document }).expect(409);
    const list = (await editor.agent.get(`${BASE}/products`).expect(200)).body;
    expect(list.find((p: { id: string }) => p.id === product.id).scheduled.versionNo).toBe(draft.body.versionNo);

    const cancelled = await send(owner, "post", `${BASE}/pricing/${draft.body.id}/unschedule`).expect(200);
    expect(cancelled.body.status).toBe("DRAFT");

    // Schedule again, then pretend the time has come: the next catalogue read activates it.
    await send(owner, "post", `${BASE}/pricing/${draft.body.id}/publish`, { effectiveFrom: when.toISOString() }).expect(
      200,
    );
    await prisma.pricingVersion.update({
      where: { id: draft.body.id },
      data: { effectiveFrom: new Date(Date.now() - 1000) },
    });
    const live = (await request(http).get("/api/v1/catalogue/products/envelopes").expect(200)).body;
    expect(live.pricingVersionId).toBe(draft.body.id);
    const archived = await prisma.pricingVersion.findUniqueOrThrow({ where: { id: original.id } });
    expect(archived.status).toBe("ARCHIVED");
    const event = await prisma.auditLog.findFirst({
      where: { action: "pricing.version_activated", targetId: draft.body.id },
    });
    expect(event?.actorKind).toBe("system");

    // Restore the seed state for other suites.
    await prisma.pricingVersion.delete({ where: { id: draft.body.id } });
    await prisma.pricingVersion.update({
      where: { id: original.id },
      data: { status: "PUBLISHED", effectiveTo: null },
    });
  });
});

describe("slug changes", () => {
  it("needs catalogue.publish, adds a redirect and updates website content", async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug: "letter-pads" } });
    expect(
      (await send(editor, "put", `${BASE}/products/${product.id}/slug`, { slug: "letter-pads-renamed" }).expect(403))
        .body.code,
    ).toBe("FORBIDDEN");
    const taken = await send(owner, "put", `${BASE}/products/${product.id}/slug`, { slug: "envelopes" }).expect(409);
    expect(taken.body.code).toBe("SLUG_TAKEN");

    const moved = await send(owner, "put", `${BASE}/products/${product.id}/slug`, {
      slug: "letter-pads-renamed",
    }).expect(200);
    expect(moved.body.slug).toBe("letter-pads-renamed");
    expect(moved.body.slugChange.redirect).toEqual({
      fromPath: "/products/letter-pads",
      toPath: "/products/letter-pads-renamed",
    });
    expect(moved.body.slugChange.contentReferencesUpdated).toBeGreaterThan(0);

    const home = (await request(http).get("/api/v1/content/pages?path=/").expect(200)).body;
    const carousel = home.blocks.find((b: { type: string }) => b.type === "productCarousel");
    expect(carousel.products.map((p: { slug: string }) => p.slug)).toContain("letter-pads-renamed");
    const settings = (await request(http).get("/api/v1/content/site-settings").expect(200)).body;
    expect(settings.redirects).toContainEqual({
      fromPath: "/products/letter-pads",
      toPath: "/products/letter-pads-renamed",
      permanent: true,
    });

    // Moving back removes the redirect that would now loop and re-points the old one.
    await send(owner, "put", `${BASE}/products/${product.id}/slug`, { slug: "letter-pads" }).expect(200);
    const redirects = await prisma.redirect.findMany({ where: { fromPath: { startsWith: "/products/letter-pads" } } });
    expect(redirects).toEqual([
      expect.objectContaining({ fromPath: "/products/letter-pads-renamed", toPath: "/products/letter-pads" }),
    ]);
    await prisma.redirect.deleteMany({ where: { fromPath: "/products/letter-pads-renamed" } });
  });

  it("changes a category slug", async () => {
    const created = await send(owner, "post", `${BASE}/categories`, {
      slug: `test-cat-${Date.now().toString(36)}`,
      name: "Test",
      summary: "Test",
    }).expect(201);
    const res = await send(owner, "put", `${BASE}/categories/${created.body.id}/slug`, {
      slug: `${created.body.slug}-x`,
    }).expect(200);
    expect(res.body.slug).toBe(`${created.body.slug}-x`);
    expect(await prisma.redirect.findUnique({ where: { fromPath: `/category/${created.body.slug}` } })).toMatchObject({
      toPath: `/category/${created.body.slug}-x`,
    });
    await prisma.redirect.deleteMany({ where: { fromPath: `/category/${created.body.slug}` } });
    await send(owner, "delete", `${BASE}/categories/${created.body.id}`).expect(200);
  });
});
