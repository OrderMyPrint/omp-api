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
let sales: Signed;
let owner: Signed;
let editor: Signed;
let cardsId: string;

const send = (s: Signed, method: "post" | "put" | "patch" | "delete", url: string, body: object = {}) =>
  s.agent[method](url).set("x-csrf-token", s.csrf).send(body);

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  sales = await signedInStaff(http, prisma, "sales", "sales-quotes");
  owner = await signedInStaff(http, prisma, "owner", "owner-quotes");
  editor = await signedInStaff(http, prisma, "content-editor", "editor-quotes");
  cardsId = (await prisma.product.findUniqueOrThrow({ where: { slug: "visiting-cards" } })).id;
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

/** Default selections for a product, as the quote editor would send them. */
async function defaults(productId: string) {
  const p = (await sales.agent.get(`/api/v1/admin/quotes/products/${productId}`).expect(200)).body;
  return Object.fromEntries(
    p.groups
      .filter((g: { defaults: string[] }) => g.defaults.length)
      .map((g: { key: string; kind: string; defaults: string[] }) => [
        g.key,
        g.kind === "MULTISELECT" ? g.defaults : g.defaults[0],
      ]),
  );
}

describe("quotations (AD-QUO-01/02)", () => {
  let webQuoteId: string;

  it("takes a request from the storefront form without pricing it", async () => {
    const body = {
      contact: { name: "Asha Rao", phone: "9876500011", email: "asha@example.com" },
      companyName: "Test Events LLP",
      items: [{ productSlug: "visiting-cards", quantity: 5000, notes: "20 names" }],
      notes: "Need by month end",
    };
    const res = await request(http).post("/api/v1/quotes/requests").send(body).expect(201);
    expect(res.body.number).toMatch(/^Q-\d{4}-\d{4}$/);
    await request(http)
      .post("/api/v1/quotes/requests")
      .send({ ...body, contact: { ...body.contact, phone: "123" } })
      .expect(400);
    await request(http).get("/api/v1/admin/quotes").expect(401);
    await editor.agent.get("/api/v1/admin/quotes").expect(403);
    const list = (await sales.agent.get("/api/v1/admin/quotes").expect(200)).body;
    const row = list.find((q: { number: string }) => q.number === res.body.number);
    expect(row).toMatchObject({ status: "REQUESTED", source: "web", name: "Test Events LLP", total: null });
    webQuoteId = row.id;
    const quote = (await sales.agent.get(`/api/v1/admin/quotes/${webQuoteId}`).expect(200)).body;
    expect(quote.request.items[0]).toMatchObject({ productName: "Visiting Cards", quantity: 5000 });
  });

  it("prices product lines with the engine and totals them with GST", async () => {
    const selections = await defaults(cardsId);
    const { gstRates } = (await sales.agent.get("/api/v1/admin/quotes/options").expect(200)).body;
    const res = await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, {
      lines: [
        { productId: cardsId, config: { selections, quantity: 5000 } },
        { description: "Delivery to two offices", quantity: 1, unitPrice: "600", gstRate: gstRates.at(-1) },
      ],
    }).expect(200);
    expect(res.body.status).toBe("UNDER_REVIEW");
    const [cards, delivery] = res.body.lines;
    expect(cards.description).toMatch(/^Visiting Cards · /);
    expect(cards.engineUnitPrice).toBe(cards.unitPrice);
    expect(cards.overridePercent).toBeNull();
    expect(Number(cards.lineSubtotal)).toBeGreaterThan(0);
    expect(delivery).toMatchObject({ engineUnitPrice: null, lineSubtotal: "600.00" });
    const sum = (k: string) =>
      res.body.lines.reduce((s: number, l: Record<string, string>) => s + Number(l[k]), 0).toFixed(2);
    expect(res.body.totals).toEqual({
      subtotal: sum("lineSubtotal"),
      tax: sum("taxAmount"),
      total: sum("lineTotal"),
    });
    // A GST rate that isn't in the catalogue is refused, and so is an unpriceable configuration.
    await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, {
      lines: [{ description: "Odd", quantity: 1, unitPrice: "10", gstRate: "7" }],
    }).expect(400);
    await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, {
      lines: [{ productId: cardsId, config: { selections, quantity: 1 } }],
    }).expect(422);
  });

  it("needs a reason and the override permission to change an engine price", async () => {
    const selections = await defaults(cardsId);
    const quote = (await sales.agent.get(`/api/v1/admin/quotes/${webQuoteId}`).expect(200)).body;
    const engine = Number(quote.lines[0].engineUnitPrice);
    const lines = [
      { productId: cardsId, config: { selections, quantity: 5000 }, unitPrice: (engine * 0.9).toFixed(4) },
    ];
    const noReason = await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, { lines }).expect(400);
    expect(noReason.body.code).toBe("OVERRIDE_REASON_REQUIRED");
    const ok = await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, {
      lines,
      overrideReason: "Repeat customer volume commitment",
    }).expect(200);
    expect(ok.body.lines[0].overridePercent).toBe("-10.0");
    expect(ok.body.overrideReason).toBe("Repeat customer volume commitment");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "quote.price_overridden", targetId: webQuoteId },
      orderBy: { at: "desc" },
    });
    expect(audit?.after).toMatchObject({ reason: "Repeat customer volume commitment" });

    // A role with quotes.write but not quotes.override_price can't change the engine price.
    const role = await prisma.role.create({
      data: { key: `quote-clerk-${Date.now()}`, name: "Quote clerk", permissions: ["quotes.read", "quotes.write"] },
    });
    const clerk = await signedInStaff(http, prisma, role.key, "quote-clerk");
    const denied = await send(clerk, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, {
      lines,
      overrideReason: "Trying anyway",
    }).expect(403);
    expect(denied.body.code).toBe("OVERRIDE_NOT_ALLOWED");
  });

  it("sends revisions, freezes what was sent and follows the pipeline", async () => {
    await send(sales, "post", `/api/v1/admin/quotes/${webQuoteId}/send`).expect(400); // no validity date yet
    const validUntil = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
    await send(sales, "patch", `/api/v1/admin/quotes/${webQuoteId}`, { validUntil }).expect(200);
    const sent = await send(sales, "post", `/api/v1/admin/quotes/${webQuoteId}/send`).expect(200);
    expect(sent.body).toMatchObject({ status: "SENT", revision: 1 });
    expect(sent.body.revisions[0].snapshot.totals).toEqual(sent.body.totals);
    await send(sales, "post", `/api/v1/admin/quotes/${webQuoteId}/move`, { status: "REQUESTED" }).expect(409);
    await send(sales, "post", `/api/v1/admin/quotes/${webQuoteId}/move`, { status: "CLARIFICATION" }).expect(200);

    // Changing the lines after sending needs a new revision; revision 1 stays as it was sent.
    const selections = await defaults(cardsId);
    const changed = await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, {
      lines: [{ productId: cardsId, config: { selections, quantity: 2500 } }],
    }).expect(200);
    expect(changed.body.revisions[0].snapshot.totals).toEqual(sent.body.totals);
    expect(changed.body.totals.total).not.toBe(sent.body.totals.total);
    const second = await send(sales, "post", `/api/v1/admin/quotes/${webQuoteId}/send`).expect(200);
    expect(second.body.revision).toBe(2);
    const accepted = await send(sales, "post", `/api/v1/admin/quotes/${webQuoteId}/move`, {
      status: "ACCEPTED",
    }).expect(200);
    expect(accepted.body.nextStatuses).toEqual([]);
    await send(sales, "put", `/api/v1/admin/quotes/${webQuoteId}/lines`, { lines: [] }).expect(409);
  });

  it("lets staff start a quotation themselves", async () => {
    const res = await send(sales, "post", "/api/v1/admin/quotes", {
      contact: { name: "Rahul Verma", phone: "+91 91234 00022" },
      companyName: "Staff Made Pvt Ltd",
    }).expect(201);
    expect(res.body).toMatchObject({ status: "UNDER_REVIEW", source: "staff", assignedTo: { id: sales.userId } });
    expect(res.body.contact.phone).toBe("+919123400022");
  });
});

describe("customers & companies (AD-CUS-01/02)", () => {
  let customerId: string;
  let companyId: string;

  beforeAll(async () => {
    const c = await prisma.user.create({ data: { kind: "CUSTOMER", name: "Priya Test", phoneE164: "+919876500033" } });
    customerId = c.id;
  });

  it("lists and finds customers, and edits their details", async () => {
    await editor.agent.get("/api/v1/admin/customers").expect(403);
    const list = (await sales.agent.get("/api/v1/admin/customers?q=98765000").expect(200)).body;
    expect(list.find((c: { id: string }) => c.id === customerId)).toMatchObject({
      name: "Priya Test",
      orders: 0,
      lifetimeValue: "0.00",
    });
    const res = await send(sales, "patch", `/api/v1/admin/customers/${customerId}`, {
      email: "Priya@Example.com",
    }).expect(200);
    expect(res.body.email).toBe("priya@example.com");
  });

  it("creates a company, checks the GSTIN and manages members", async () => {
    await send(sales, "post", "/api/v1/admin/companies", { name: "Bad GST Ltd", gstin: "123456789012345" }).expect(400);
    const created = await send(sales, "post", "/api/v1/admin/companies", {
      name: "Acme Test Industries",
      gstin: "27ABCDE1234F1Z5",
    }).expect(201);
    companyId = created.body.id;
    await send(sales, "post", "/api/v1/admin/companies", { name: "Copy", gstin: "27ABCDE1234F1Z5" }).expect(409);
    await send(sales, "put", `/api/v1/admin/companies/${companyId}/members`, {
      phone: "9000000000",
      role: "MEMBER",
    }).expect(404);
    const withMember = await send(sales, "put", `/api/v1/admin/companies/${companyId}/members`, {
      phone: "98765 00033",
      role: "ADMIN",
    }).expect(200);
    expect(withMember.body.members).toEqual([expect.objectContaining({ id: customerId, role: "ADMIN" })]);
    const customer = (await sales.agent.get(`/api/v1/admin/customers/${customerId}`).expect(200)).body;
    expect(customer.companies).toEqual([{ id: companyId, name: "Acme Test Industries", role: "ADMIN" }]);
  });

  it("only lets an approver set credit terms, with a fresh authenticator code", async () => {
    const body = { enabled: true, termsDays: 30 };
    await send(sales, "put", `/api/v1/admin/companies/${companyId}/credit`, body).expect(403);
    const needsCode = await send(owner, "put", `/api/v1/admin/companies/${companyId}/credit`, body).expect(403);
    expect(needsCode.body.code).toBe("STEP_UP_REQUIRED");
    await send(owner, "post", "/api/v1/admin/auth/step-up", { code: nextCode(owner.secret) }).expect(200);
    await send(owner, "put", `/api/v1/admin/companies/${companyId}/credit`, { enabled: true, termsDays: null }).expect(
      400,
    );
    const res = await send(owner, "put", `/api/v1/admin/companies/${companyId}/credit`, body).expect(200);
    expect(res.body.credit).toMatchObject({ enabled: true, termsDays: 30, approvedBy: "owner-quotes" });
    const audit = await prisma.auditLog.findFirst({ where: { action: "company.credit_changed", targetId: companyId } });
    expect(audit?.actorId).toBe(owner.userId);
  });
});
