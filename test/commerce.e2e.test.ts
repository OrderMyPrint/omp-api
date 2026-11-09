import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConsoleSms,
  SMS_SENDER,
  isProductionDeployment,
  smsSenderFromEnv,
  paymentProvidersFromEnv,
} from "../src/providers/providers";
import { createApp } from "../src/setup";
import { nextCode, signedInStaff, type Signed } from "./helpers";

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
let sms: ConsoleSms;
const prisma = new PrismaClient();
let owner: Signed;
let sales: Signed;

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
type Agent = ReturnType<typeof request.agent>;

async function signIn(agent: Agent, mobile: string) {
  await agent.post("/api/v1/auth/otp/request").send({ phone: mobile }).expect(200);
  const code = sms.lastCode(`+91${mobile}`)!;
  const res = await agent.post("/api/v1/auth/otp/verify").send({ phone: mobile, code }).expect(200);
  return res.body.csrfToken as string;
}

async function defaults(slug: string) {
  const product = (await request(http).get(`/api/v1/catalogue/products/${slug}`).expect(200)).body;
  const selections = Object.fromEntries(
    product.optionGroups.map((g: { key: string; kind: string; defaults: string[] }) => [
      g.key,
      g.kind === "MULTISELECT" ? g.defaults : g.defaults[0],
    ]),
  );
  return { productSlug: slug, selections, quantity: product.quantity.minimum as number };
}

const address = { name: "Test Buyer", line1: "12 Test Street", city: "Ahmedabad", state: "Gujarat", pincode: "380001" };

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  sms = app.get(SMS_SENDER);
  owner = await signedInStaff(http, prisma, "owner", "owner-orders");
  sales = await signedInStaff(http, prisma, "sales", "sales-orders");
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("providers", () => {
  it("refuses the development stand-ins on a production deployment", () => {
    const before = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    expect(isProductionDeployment()).toBe(true);
    expect(smsSenderFromEnv()).toBeNull();
    expect(paymentProvidersFromEnv()).toEqual([]);
    process.env.VERCEL_ENV = before;
    if (before === undefined) delete process.env.VERCEL_ENV;
  });
});

describe("customer sign-in (OTP)", () => {
  it("signs in with a code, creating the customer once", async () => {
    const agent = request.agent(http);
    const mobile = phone();
    await agent.post("/api/v1/auth/otp/request").send({ phone: "12345" }).expect(400);
    const sent = await agent
      .post("/api/v1/auth/otp/request")
      .send({ phone: `+91 ${mobile}` })
      .expect(200);
    expect(sent.body).toMatchObject({ expiresInSec: 600, resendAfterSec: 30 });
    const again = await agent.post("/api/v1/auth/otp/request").send({ phone: mobile }).expect(429);
    expect(again.body.code).toBe("OTP_RESEND_WAIT");

    const code = sms.lastCode(`+91${mobile}`)!;
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await agent.post("/api/v1/auth/otp/verify").send({ phone: mobile, code: wrong }).expect(400);
    expect(bad.body).toMatchObject({ code: "OTP_INVALID", attemptsLeft: 2 });
    const ok = await agent.post("/api/v1/auth/otp/verify").send({ phone: mobile, code }).expect(200);
    expect(ok.body).toMatchObject({ phone: `+91${mobile}`, needsProfile: true, isNew: true });
    await agent.post("/api/v1/auth/otp/verify").send({ phone: mobile, code }).expect(400);

    const me = await agent.get("/api/v1/auth/me").expect(200);
    await agent.patch("/api/v1/auth/me").send({ name: "Asha" }).expect(403); // CSRF header missing
    const named = await agent
      .patch("/api/v1/auth/me")
      .set("x-csrf-token", me.body.csrfToken)
      .send({ name: "Asha Patel" })
      .expect(200);
    expect(named.body.needsProfile).toBe(false);
  });

  it("locks the number after three wrong codes", async () => {
    const mobile = phone();
    await request(http).post("/api/v1/auth/otp/request").send({ phone: mobile }).expect(200);
    const code = sms.lastCode(`+91${mobile}`)!;
    const wrong = code === "000000" ? "111111" : "000000";
    await request(http).post("/api/v1/auth/otp/verify").send({ phone: mobile, code: wrong }).expect(400);
    await request(http).post("/api/v1/auth/otp/verify").send({ phone: mobile, code: wrong }).expect(400);
    const locked = await request(http).post("/api/v1/auth/otp/verify").send({ phone: mobile, code: wrong }).expect(429);
    expect(locked.body.code).toBe("OTP_LOCKED");
    await request(http).post("/api/v1/auth/otp/verify").send({ phone: mobile, code }).expect(429);
    expect((await request(http).post("/api/v1/auth/otp/request").send({ phone: mobile }).expect(429)).body.code).toBe(
      "OTP_LOCKED",
    );
  });
});

describe("cart, checkout and payment", () => {
  let agent: Agent;
  beforeAll(() => {
    agent = request.agent(http);
  });
  let csrf: string;
  let orderNumber: string;
  let orderId: string;
  let total: string;

  it("keeps a guest cart and merges it on sign-in", async () => {
    const item = await defaults("visiting-cards");
    const added = await agent.post("/api/v1/cart/items").send(item).expect(201);
    expect(added.body.items).toHaveLength(1);
    expect(added.body.items[0]).toMatchObject({ priceChanged: false, problem: null });
    expect(added.body.shipping).toBeNull();
    await agent
      .post("/api/v1/cart/items")
      .send({ ...item, selections: { ...item.selections, paper: "nope" } })
      .expect(422);

    csrf = await signIn(agent, phone());
    const cart = await agent.get("/api/v1/cart").expect(200);
    expect(cart.body.items).toHaveLength(1);
    const letter = await defaults("letter-pads");
    const two = await agent.post("/api/v1/cart/items").set("x-csrf-token", csrf).send(letter).expect(201);
    expect(two.body.items).toHaveLength(2);
    expect(two.body.canCheckout).toBe(true);
    total = two.body.total;
  });

  it("places one order per idempotency key and refuses a stale total", async () => {
    const body = { name: "Asha Patel", billingAddress: address, acceptTerms: true, expectedTotal: total };
    await agent.post("/api/v1/checkout/orders").set("x-csrf-token", csrf).send(body).expect(400);
    const stale = await agent
      .post("/api/v1/checkout/orders")
      .set("x-csrf-token", csrf)
      .set("idempotency-key", "key-stale-0001")
      .send({ ...body, expectedTotal: "1.00" })
      .expect(409);
    expect(stale.body).toMatchObject({ code: "PRICE_CHANGED", total });

    const placed = await agent
      .post("/api/v1/checkout/orders")
      .set("x-csrf-token", csrf)
      .set("idempotency-key", "key-place-0001")
      .send({ ...body, gstin: "24abcde1234f1z5", companyName: "=HYPERLINK(1)" })
      .expect(201);
    expect(placed.body).toMatchObject({ status: "AWAITING_PAYMENT", payment: "PENDING", gstin: "24ABCDE1234F1Z5" });
    expect(placed.body.orderNumber).toMatch(/^OMP-\d{4}-\d{6}$/);
    expect(placed.body.totals.total).toBe(total);
    expect(placed.body.items).toHaveLength(2);
    expect(placed.body.items[0].spec.options.length).toBeGreaterThan(0);
    orderNumber = placed.body.orderNumber;
    orderId = placed.body.id;

    const retry = await agent
      .post("/api/v1/checkout/orders")
      .set("x-csrf-token", csrf)
      .set("idempotency-key", "key-place-0001")
      .send({ ...body, expectedTotal: "1.00" })
      .expect(201);
    expect(retry.body.orderNumber).toBe(orderNumber);
    expect((await agent.get("/api/v1/cart").expect(200)).body.items).toHaveLength(0);
    expect(await prisma.order.count({ where: { orderNumber } })).toBe(1);
  });

  it("turns paid only on a verified gateway event with the right amount, once", async () => {
    const pay = await agent.post(`/api/v1/checkout/orders/${orderNumber}/pay`).set("x-csrf-token", csrf).expect(200);
    expect(pay.body).toMatchObject({ provider: "test", amount: total, action: { type: "test" } });
    const ref = pay.body.providerRef;

    // A forged webhook is rejected and recorded.
    await request(http)
      .post("/api/v1/payments/webhooks/test")
      .set("x-test-signature", "deadbeef")
      .send({ id: "evt_forged", event: "payment.captured", payment: { id: ref, amount: total } })
      .expect(400);
    // Wrong amount: recorded, not applied.
    const short = await request(http)
      .post("/api/v1/payments/test/complete")
      .send({ providerRef: ref, outcome: "captured", amount: "1.00" })
      .expect(200);
    expect(short.body.outcome).toBe("rejected");
    expect((await agent.get(`/api/v1/account/orders/${orderNumber}`).expect(200)).body.status).toBe("AWAITING_PAYMENT");

    const ok = await request(http)
      .post("/api/v1/payments/test/complete")
      .send({ providerRef: ref, outcome: "captured", amount: total, eventId: "evt_capture_1" })
      .expect(200);
    expect(ok.body.outcome).toBe("applied");
    const dup = await request(http)
      .post("/api/v1/payments/test/complete")
      .send({ providerRef: ref, outcome: "captured", amount: total, eventId: "evt_capture_1" })
      .expect(200);
    expect(dup.body.outcome).toBe("duplicate");

    const mine = await agent.get(`/api/v1/account/orders/${orderNumber}`).expect(200);
    expect(mine.body).toMatchObject({ status: "PAID", payment: "PAID" });
    expect(mine.body.events.map((e: { kind: string }) => e.kind)).toContain("payment.captured");
    const list = await agent.get("/api/v1/account/orders").expect(200);
    expect(list.body[0]).toMatchObject({ orderNumber, status: "PAID" });
    await agent.post(`/api/v1/checkout/orders/${orderNumber}/pay`).set("x-csrf-token", csrf).expect(409);
  });

  it("never lets one customer see another's order", async () => {
    const other = request.agent(http);
    await signIn(other, phone());
    await other.get(`/api/v1/account/orders/${orderNumber}`).expect(404);
    await request(http).get("/api/v1/account/orders").expect(401);
  });

  it("keeps order item snapshots immutable in the database", async () => {
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
    await expect(prisma.orderItem.update({ where: { id: item.id }, data: { quantity: 1 } })).rejects.toThrow(
      /cannot be edited/,
    );
  });

  describe("admin", () => {
    it("lists, filters, searches and exports orders", async () => {
      const list = (await sales.agent.get("/api/v1/admin/orders?status=PAID").expect(200)).body;
      expect(list.items.find((o: { orderNumber: string }) => o.orderNumber === orderNumber)).toMatchObject({
        payment: "PAID",
        status: "PAID",
        grandTotal: total,
      });
      expect(list.counts.PAID).toBeGreaterThanOrEqual(1);
      const found = (await sales.agent.get(`/api/v1/admin/orders?q=${orderNumber}`).expect(200)).body;
      expect(found.total).toBe(1);
      const csv = await sales.agent.get(`/api/v1/admin/orders/export.csv?q=${orderNumber}`).expect(200);
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.text).toContain(orderNumber);
      expect(csv.text).toContain(`"'=HYPERLINK(1)"`);

      const detail = (await sales.agent.get(`/api/v1/admin/orders/${orderId}`).expect(200)).body;
      expect(detail.items[0].pricingVersionNo).toBeGreaterThanOrEqual(1);
      expect(detail.paymentEvents.map((e: { outcome: string }) => e.outcome)).toEqual(
        expect.arrayContaining(["rejected", "applied", "duplicate"]),
      );
    });

    it("puts on hold and releases (orders.write)", async () => {
      expect(
        (
          await sales.agent
            .post(`/api/v1/admin/orders/${orderId}/hold`)
            .set("x-csrf-token", sales.csrf)
            .send({ reason: "x" })
            .expect(403)
        ).body.missing,
      ).toEqual(["orders.write"]);
      const held = await owner.agent
        .post(`/api/v1/admin/orders/${orderId}/hold`)
        .set("x-csrf-token", owner.csrf)
        .send({ reason: "Waiting for customer reply", reviewOn: "2026-12-01", note: "Colour check" })
        .expect(200);
      expect(held.body).toMatchObject({ onHold: true, holdReason: "Waiting for customer reply" });
      expect(
        (await owner.agent.get("/api/v1/admin/orders?status=ON_HOLD").expect(200)).body.total,
      ).toBeGreaterThanOrEqual(1);
      const released = await owner.agent
        .post(`/api/v1/admin/orders/${orderId}/release`)
        .set("x-csrf-token", owner.csrf)
        .send({})
        .expect(200);
      expect(released.body.onHold).toBe(false);
      expect(released.body.events[0]).toMatchObject({ kind: "order.released", actorName: "owner-orders" });
    });

    it("cancels items with a fresh code and requests the refund", async () => {
      const detail = (await owner.agent.get(`/api/v1/admin/orders/${orderId}`).expect(200)).body;
      const [first, second] = detail.items;
      const denied = await owner.agent
        .post(`/api/v1/admin/orders/${orderId}/cancel`)
        .set("x-csrf-token", owner.csrf)
        .send({ reason: "Customer request", itemIds: [second.id] })
        .expect(403);
      expect(denied.body.code).toBe("STEP_UP_REQUIRED");
      await owner.agent
        .post("/api/v1/admin/auth/step-up")
        .set("x-csrf-token", owner.csrf)
        .send({ code: nextCode(owner.secret) })
        .expect(200);
      const partial = await owner.agent
        .post(`/api/v1/admin/orders/${orderId}/cancel`)
        .set("x-csrf-token", owner.csrf)
        .send({ reason: "Customer request", itemIds: [second.id] })
        .expect(200);
      expect(partial.body.status).toBe("PAID");
      expect(partial.body.refunds).toEqual([
        expect.objectContaining({ amount: second.lineTotal, status: "REQUESTED" }),
      ]);
      expect(partial.body.payment).toBe("REFUND_REQUESTED");

      const all = await owner.agent
        .post(`/api/v1/admin/orders/${orderId}/cancel`)
        .set("x-csrf-token", owner.csrf)
        .send({ reason: "Customer request" })
        .expect(200);
      expect(all.body.status).toBe("CANCELLED");
      expect(all.body.refunds.map((r: { amount: string }) => r.amount).sort()).toEqual(
        [first.lineTotal, second.lineTotal].sort(),
      );
      await owner.agent
        .post(`/api/v1/admin/orders/${orderId}/cancel`)
        .set("x-csrf-token", owner.csrf)
        .send({ reason: "Again" })
        .expect(409);
      const audit = await prisma.auditLog.findMany({ where: { targetId: orderId }, orderBy: { at: "asc" } });
      expect(audit.map((a) => a.action)).toEqual([
        "orders.held",
        "orders.released",
        "orders.items_cancelled",
        "orders.cancelled",
      ]);
    });
  });
});
