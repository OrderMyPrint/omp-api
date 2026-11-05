import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/setup";

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
});

const visitingCards = {
  productSlug: "visiting-cards",
  selections: {
    size: "standard",
    paper: "premium-matte-350",
    sides: "double",
    finish: "soft-touch",
    corners: "square",
  },
  quantity: 500,
};

describe("health", () => {
  it("reports the database as reachable", async () => {
    const res = await request(http).get("/api/v1/health").expect(200);
    expect(res.body).toEqual({ status: "ok", database: "ok" });
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("catalogue", () => {
  it("lists the four categories with product counts", async () => {
    const res = await request(http).get("/api/v1/catalogue/categories").expect(200);
    expect(res.body.map((c: { slug: string }) => c.slug)).toEqual([
      "business-stationery",
      "marketing-print",
      "custom-transfers",
      "corporate-merchandise",
    ]);
    expect(res.body[0].productCount).toBe(3);
  });

  it("filters products by category and search text", async () => {
    const byCategory = await request(http).get("/api/v1/catalogue/products?category=marketing-print").expect(200);
    expect(byCategory.body.map((p: { slug: string }) => p.slug)).toEqual(["brochures", "stickers"]);
    const bySearch = await request(http).get("/api/v1/catalogue/products?q=envelope").expect(200);
    expect(bySearch.body.map((p: { slug: string }) => p.slug)).toEqual(["envelopes"]);
    expect(bySearch.body[0]).toMatchObject({ startingPrice: "600.00", minimumQuantity: 100, gstRate: "18.00" });
  });

  it("returns a product with options, artwork slots and tiers", async () => {
    const res = await request(http).get("/api/v1/catalogue/products/corporate-t-shirts").expect(200);
    expect(res.body.quantity).toMatchObject({ mode: "sizes", minimum: 25, quoteFrom: 300 });
    expect(res.body.optionGroups.map((g: { key: string }) => g.key)).toEqual([
      "garment",
      "fabric",
      "colour",
      "method",
      "locations",
    ]);
    const polo = res.body.optionGroups[0].options.find((o: { key: string }) => o.key === "polo");
    expect(polo).toMatchObject({ available: false, unavailableReason: "Priced on quotation" });
    expect(res.body.artworkSlots.map((s: { key: string }) => s.key)).toEqual(["front", "back"]);
    expect(res.body.tiers[2]).toEqual({ minQty: 80, unitPrice: "299.00", total: "23920.00", savingPercent: 14 });
    expect(res.headers["cache-control"]).toContain("s-maxage=60");
  });

  it("returns problem+json for an unknown product and a bad slug", async () => {
    const missing = await request(http).get("/api/v1/catalogue/products/no-such-thing").expect(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.body).toMatchObject({ status: 404, code: "PRODUCT_NOT_FOUND" });
    const bad = await request(http).get("/api/v1/catalogue/products/DROP%20TABLE").expect(400);
    expect(bad.body.code).toBe("REQUEST_INVALID");
  });
});

describe("pricing preview", () => {
  it("prices the Figma reference configuration at ₹1,652.00", async () => {
    const res = await request(http).post("/api/v1/pricing/preview").send(visitingCards).expect(200);
    expect(res.body).toMatchObject({
      valid: true,
      subtotal: "1400.00",
      gst: "252.00",
      total: "1652.00",
      gstRate: "18.00",
    });
    expect(res.body.pricingVersionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns field errors instead of a price for invalid configurations", async () => {
    const res = await request(http)
      .post("/api/v1/pricing/preview")
      .send({ ...visitingCards, selections: { ...visitingCards.selections, paper: "gold-leaf" }, quantity: 10 })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.total).toBeNull();
    expect(res.body.errors.map((e: { code: string }) => e.code).sort()).toEqual([
      "QUANTITY_BELOW_MINIMUM",
      "UNKNOWN_OPTION",
    ]);
  });

  it("rejects malformed bodies and unexpected fields", async () => {
    const res = await request(http)
      .post("/api/v1/pricing/preview")
      .send({ ...visitingCards, total: "1.00" })
      .expect(400);
    expect(res.body.code).toBe("REQUEST_INVALID");
    await request(http)
      .post("/api/v1/pricing/preview")
      .set("content-type", "application/json")
      .send("{bad")
      .expect(400);
  });

  it("allows only configured browser origins", async () => {
    const ok = await request(http).get("/api/v1/health").set("Origin", "http://localhost:3000");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const other = await request(http).get("/api/v1/health").set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("publishes an OpenAPI document", async () => {
    const res = await request(http).get("/api/v1/openapi.json").expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(["/api/v1/pricing/preview", "/api/v1/catalogue/products/{slug}"]),
    );
  });
});
