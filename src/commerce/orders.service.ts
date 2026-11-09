import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Order, OrderStatus, Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { AuditService, type AuditContext } from "../auth/audit.service";
import type { StaffContext } from "../auth/auth.service";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import {
  PAYMENT_PROVIDERS,
  TestPaymentProvider,
  type PaymentProvider,
  type VerifiedPaymentEvent,
} from "../providers/providers";
import { CartService, specOf } from "./cart.service";
import type { CustomerContext } from "./customer-auth";

const TX = { timeout: 20_000, maxWait: 10_000 };

export type Address = {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  phone?: string;
};
export type CheckoutInput = {
  name: string;
  email?: string;
  billingAddress: Address;
  shippingAddress?: Address;
  gstin?: string;
  companyName?: string;
  acceptTerms: true;
  expectedTotal: string;
};

/** Statuses after which items are being made or sent and can no longer be cancelled here. */
const LOCKED: OrderStatus[] = ["IN_PRODUCTION", "READY_TO_DISPATCH", "DISPATCHED", "DELIVERED"];

const money = (d: Prisma.Decimal | Decimal | string) => new Decimal(d.toString()).toFixed(2);
const istYear = (at = new Date()) => new Date(at.getTime() + 5.5 * 3600_000).getUTCFullYear();

const orderInclude = {
  items: { orderBy: { id: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
  refunds: { orderBy: { createdAt: "asc" } },
  events: { orderBy: { at: "desc" } },
  user: { select: { id: true, name: true, phoneE164: true, email: true } },
} satisfies Prisma.OrderInclude;
type FullOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/**
 * Checkout, payments and order administration (SF-CHK, SF-ACC-02/03, AD-ORD-01/02).
 * An order is created in AWAITING_PAYMENT with immutable snapshots; it becomes PAID only on
 * a verified, de-duplicated gateway event whose amount matches — never on a browser redirect.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger("Orders");

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly audit: AuditService,
    @Optional() @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProvider[] = [],
  ) {}

  testProvider() {
    return (this.providers ?? []).find((p): p is TestPaymentProvider => p instanceof TestPaymentProvider) ?? null;
  }

  private async nextNumber(tx: Prisma.TransactionClient) {
    const year = istYear();
    const seq = await tx.orderSequence.upsert({
      where: { year },
      update: { last: { increment: 1 } },
      create: { year, last: 1 },
    });
    return `OMP-${year}-${String(seq.last).padStart(6, "0")}`;
  }

  private event(
    tx: Prisma.TransactionClient,
    orderId: string,
    kind: string,
    message: string,
    actor: { kind: "customer" | "staff" | "system"; id?: string | null },
    detail?: unknown,
  ) {
    return tx.orderEvent.create({
      data: {
        orderId,
        kind,
        message,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        detail: detail === undefined ? undefined : (detail as Prisma.InputJsonValue),
      },
    });
  }

  // ---------------------------------------------------------------- checkout

  async placeOrder(customer: CustomerContext, cartId: string | null, key: string, input: CheckoutInput) {
    const existing = await this.prisma.order.findUnique({
      where: { userId_idempotencyKey: { userId: customer.user.id, idempotencyKey: key } },
    });
    if (existing) return this.customerOrder(customer, existing.orderNumber);
    if (!cartId) throw new ProblemException(409, "CART_EMPTY", "Your cart is empty");

    const lines = await this.cart.priceLines(cartId);
    if (!lines.length) throw new ProblemException(409, "CART_EMPTY", "Your cart is empty");
    const problems = lines.filter((l) => l.problem).map((l) => l.problem!);
    if (problems.length)
      throw new ProblemException(409, "CART_INVALID", "Some items can't be ordered as they are", undefined, {
        problems,
      });
    const totals = this.cart.view(lines);
    if (totals.total !== new Decimal(input.expectedTotal).toFixed(2))
      throw new ProblemException(
        409,
        "PRICE_CHANGED",
        "Prices have changed since you reviewed your order",
        "Check the new total and place the order again.",
        { total: totals.total, subtotal: totals.subtotal, gst: totals.gst },
      );

    const shipping = input.shippingAddress ?? input.billingAddress;
    if (input.email) {
      const clash = await this.prisma.user.findFirst({
        where: { email: input.email.toLowerCase(), id: { not: customer.user.id } },
      });
      if (clash) throw new ProblemException(409, "EMAIL_IN_USE", "This email is used by another account");
    }
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: customer.user.id },
        data: { name: input.name, ...(input.email ? { email: input.email.toLowerCase() } : {}) },
      });
      const orderNumber = await this.nextNumber(tx);
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: customer.user.id,
          idempotencyKey: key,
          contact: { name: input.name, phone: customer.user.phoneE164, email: input.email ?? null },
          billingAddress: input.billingAddress as Prisma.InputJsonValue,
          shippingAddress: shipping as Prisma.InputJsonValue,
          gstin: input.gstin ?? null,
          companyName: input.companyName ?? null,
          placeOfSupplyState: shipping.state,
          subtotal: totals.subtotal,
          taxTotal: totals.gst,
          grandTotal: totals.total,
          items: {
            create: lines.map((l) => ({
              productId: l.product!.row.id,
              productName: l.product!.row.name,
              specSnapshot: specOf(l.product!, l.item.configuration) as Prisma.InputJsonValue,
              priceSnapshot: {
                lines: l.result!.lines,
                subtotal: l.result!.subtotal,
                gstRate: l.result!.gstRate,
                gst: l.result!.gst,
                total: l.result!.total,
                configuration: l.item.configuration,
              } as Prisma.InputJsonValue,
              pricingVersionId: l.product!.pricingVersionId,
              quantity: l.result!.quantity,
              unitPrice: l.result!.unitPrice!,
              lineSubtotal: l.result!.subtotal!,
              gstRate: l.result!.gstRate,
              taxAmount: l.result!.gst!,
              lineTotal: l.result!.total!,
            })),
          },
        },
      });
      await this.event(tx, created.id, "order.placed", "Order placed", { kind: "customer", id: customer.user.id });
      await tx.cartItem.deleteMany({ where: { cartId } });
      return created;
    }, TX);
    return this.customerOrder(customer, order.orderNumber);
  }

  async startPayment(customer: CustomerContext, orderNumber: string) {
    const provider = (this.providers ?? [])[0];
    if (!provider)
      throw new ProblemException(
        503,
        "PAYMENTS_NOT_OPEN",
        "Online payment isn't open yet",
        "Payments open once a payment gateway is set up.",
      );
    const order = await this.prisma.order.findFirst({ where: { orderNumber, userId: customer.user.id } });
    if (!order) throw new ProblemException(404, "NOT_FOUND", "Order not found");
    if (order.status !== "AWAITING_PAYMENT" || order.cancelledAt)
      throw new ProblemException(409, "NOT_PAYABLE", "This order doesn't need a payment");
    const amount = money(order.grandTotal);
    const created = await provider.createPayment({ orderNumber, amount });
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: { orderId: order.id, provider: provider.name, providerRef: created.providerRef, amount },
      });
      await this.event(tx, order.id, "payment.started", `Payment started (${provider.name})`, {
        kind: "customer",
        id: customer.user.id,
      });
    }, TX);
    return { provider: provider.name, providerRef: created.providerRef, amount, action: created.action };
  }

  // ---------------------------------------------------------------- gateway events

  /** Verifies, records and applies a gateway event exactly once. */
  async handleWebhook(providerName: string, headers: Record<string, string | string[] | undefined>, body: unknown) {
    const provider = (this.providers ?? []).find((p) => p.name === providerName);
    if (!provider) throw new ProblemException(404, "NOT_FOUND", "Unknown payment provider");
    const verified = provider.verifyWebhook(headers, body);
    const rawId = (body as { id?: unknown })?.id;
    if (!verified) {
      await this.prisma.paymentEvent
        .create({
          data: {
            provider: providerName,
            eventId: `rejected:${typeof rawId === "string" ? rawId.slice(0, 80) : "unknown"}:${Date.now()}`,
            kind: "unverified",
            verified: false,
            outcome: "rejected",
            payload: (body ?? {}) as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      throw new ProblemException(400, "SIGNATURE_INVALID", "Webhook signature is not valid");
    }
    return this.applyEvent(providerName, verified, body);
  }

  private async applyEvent(provider: string, ev: VerifiedPaymentEvent, body: unknown) {
    const payment = await this.prisma.payment.findUnique({
      where: { provider_providerRef: { provider, providerRef: ev.providerRef } },
      include: { order: true },
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        let outcome = "applied";
        if (!payment) outcome = "ignored";
        else if (ev.kind === "payment.captured") {
          if (!new Decimal(ev.amount).equals(payment.amount)) outcome = "rejected";
          else if (payment.status === "CAPTURED") outcome = "ignored";
          else {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: "CAPTURED", capturedAt: new Date(), method: ev.method ?? null },
            });
            const order = payment.order;
            if (order.status === "AWAITING_PAYMENT" && !order.cancelledAt) {
              await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });
              await this.event(tx, order.id, "payment.captured", `Payment captured — ₹${money(payment.amount)}`, {
                kind: "system",
              });
            } else {
              // Paid after cancellation, or a second payment: the money goes back.
              await tx.refund.create({
                data: {
                  orderId: order.id,
                  paymentId: payment.id,
                  amount: payment.amount,
                  reason: order.cancelledAt ? "Payment received after cancellation" : "Duplicate payment",
                },
              });
              await this.event(
                tx,
                order.id,
                "refund.requested",
                `Unexpected payment of ₹${money(payment.amount)} — refund requested`,
                { kind: "system" },
              );
            }
          }
        } else if (ev.kind === "payment.failed") {
          if (payment.status === "CREATED") {
            await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failedAt: new Date() } });
            await this.event(tx, payment.orderId, "payment.failed", "Payment failed or was cancelled", {
              kind: "system",
            });
          } else outcome = "ignored";
        }
        await tx.paymentEvent.create({
          data: {
            provider,
            eventId: ev.eventId,
            kind: ev.kind,
            providerRef: ev.providerRef,
            orderId: payment?.orderId ?? null,
            amount: ev.amount,
            verified: true,
            outcome,
            payload: (body ?? {}) as Prisma.InputJsonValue,
          },
        });
        return { outcome };
      }, TX);
    } catch (error) {
      // Same event id again: already processed.
      if ((error as { code?: string }).code === "P2002") {
        await this.prisma.paymentEvent
          .create({
            data: {
              provider,
              eventId: `${ev.eventId}#dup:${Date.now()}`,
              kind: ev.kind,
              providerRef: ev.providerRef,
              orderId: payment?.orderId ?? null,
              amount: ev.amount,
              verified: true,
              outcome: "duplicate",
              payload: (body ?? {}) as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
        return { outcome: "duplicate" };
      }
      this.logger.error(error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }

  // ---------------------------------------------------------------- customer views

  async customerOrders(customer: CustomerContext) {
    const rows = await this.prisma.order.findMany({
      where: { userId: customer.user.id },
      orderBy: { placedAt: "desc" },
      take: 100,
      include: { items: { select: { productName: true, quantity: true, status: true } } },
    });
    return rows.map((o) => ({
      orderNumber: o.orderNumber,
      status: o.status,
      onHold: o.onHold,
      placedAt: o.placedAt,
      grandTotal: money(o.grandTotal),
      items: o.items.map((i) => ({ productName: i.productName, quantity: i.quantity, status: i.status })),
    }));
  }

  async customerOrder(customer: CustomerContext, orderNumber: string) {
    const order = await this.prisma.order.findFirst({
      where: { orderNumber, userId: customer.user.id },
      include: orderInclude,
    });
    if (!order) throw new ProblemException(404, "NOT_FOUND", "Order not found");
    const full = this.view(order);
    // Customers see their own timeline without staff notes or internal actors.
    return {
      ...full,
      events: order.events
        .filter((e) => !e.kind.startsWith("note"))
        .map((e) => ({ kind: e.kind, message: e.message, at: e.at })),
      paymentEvents: undefined,
    };
  }

  private paymentLabel(order: FullOrder) {
    if (order.refunds.some((r) => r.status === "PROCESSED")) return "REFUNDED";
    if (order.refunds.length) return "REFUND_REQUESTED";
    if (order.paidAt) return "PAID";
    const last = order.payments[order.payments.length - 1];
    if (last?.status === "FAILED") return "FAILED";
    return "PENDING";
  }

  private view(order: FullOrder) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      payment: this.paymentLabel(order),
      onHold: order.onHold,
      holdReason: order.holdReason,
      holdReviewOn: order.holdReviewOn,
      cancelReason: order.cancelReason,
      cancelledAt: order.cancelledAt,
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      contact: order.contact,
      customer: { id: order.user.id, name: order.user.name, phone: order.user.phoneE164 },
      billingAddress: order.billingAddress,
      shippingAddress: order.shippingAddress,
      gstin: order.gstin,
      companyName: order.companyName,
      placeOfSupplyState: order.placeOfSupplyState,
      totals: {
        subtotal: money(order.subtotal),
        discount: money(order.discountTotal),
        shipping: money(order.shippingTotal),
        tax: money(order.taxTotal),
        total: money(order.grandTotal),
      },
      items: order.items.map((i) => ({
        id: i.id,
        productName: i.productName,
        spec: i.specSnapshot,
        price: i.priceSnapshot,
        pricingVersionId: i.pricingVersionId,
        quantity: i.quantity,
        unitPrice: new Decimal(i.unitPrice.toString()).toFixed(2),
        lineTotal: money(i.lineTotal),
        gstRate: i.gstRate.toFixed(2),
        status: i.status,
      })),
      payments: order.payments.map((p) => ({
        id: p.id,
        provider: p.provider,
        providerRef: p.providerRef,
        amount: money(p.amount),
        status: p.status,
        method: p.method,
        createdAt: p.createdAt,
        capturedAt: p.capturedAt,
      })),
      refunds: order.refunds.map((r) => ({
        id: r.id,
        amount: money(r.amount),
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      })),
      events: order.events.map((e) => ({
        kind: e.kind,
        message: e.message,
        detail: e.detail,
        actorKind: e.actorKind,
        actorId: e.actorId,
        at: e.at,
      })),
    };
  }

  // ---------------------------------------------------------------- admin

  async adminList(filter: { status?: string; q?: string; page: number; pageSize: number }) {
    const where: Prisma.OrderWhereInput = {
      ...(filter.status === "ON_HOLD"
        ? { onHold: true }
        : filter.status
          ? { status: filter.status as OrderStatus }
          : {}),
      ...(filter.q
        ? {
            OR: [
              { orderNumber: { contains: filter.q, mode: "insensitive" } },
              { companyName: { contains: filter.q, mode: "insensitive" } },
              { user: { name: { contains: filter.q, mode: "insensitive" } } },
              { user: { phoneE164: { contains: filter.q.replace(/\s/g, "") } } },
            ],
          }
        : {}),
    };
    const [rows, total, grouped, held] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { placedAt: "desc" },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
        include: {
          user: { select: { name: true, phoneE164: true } },
          refunds: { select: { status: true } },
          payments: { select: { status: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.order.count({ where: { onHold: true } }),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customer: o.companyName ?? (o.user.name || o.user.phoneE164),
        placedAt: o.placedAt,
        payment: o.refunds.some((r) => r.status === "PROCESSED")
          ? "REFUNDED"
          : o.refunds.length
            ? "REFUND_REQUESTED"
            : o.paidAt
              ? "PAID"
              : o.payments[0]?.status === "FAILED"
                ? "FAILED"
                : "PENDING",
        status: o.status,
        onHold: o.onHold,
        grandTotal: money(o.grandTotal),
      })),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
      counts: { ...Object.fromEntries(grouped.map((g) => [g.status, g._count._all])), ON_HOLD: held },
    };
  }

  async adminOrder(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: orderInclude });
    if (!order) throw new ProblemException(404, "NOT_FOUND", "Order not found");
    const [paymentEvents, versions, actors] = await Promise.all([
      this.prisma.paymentEvent.findMany({ where: { orderId: id }, orderBy: { receivedAt: "asc" } }),
      this.prisma.pricingVersion.findMany({
        where: { id: { in: order.items.map((i) => i.pricingVersionId) } },
        select: { id: true, versionNo: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: order.events.map((e) => e.actorId).filter((x): x is string => !!x) } },
        select: { id: true, name: true, kind: true },
      }),
    ]);
    const full = this.view(order);
    return {
      ...full,
      items: full.items.map((i) => ({
        ...i,
        pricingVersionNo: versions.find((v) => v.id === i.pricingVersionId)?.versionNo ?? null,
      })),
      events: full.events.map((e) => ({ ...e, actorName: actors.find((a) => a.id === e.actorId)?.name ?? null })),
      paymentEvents: paymentEvents.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventId: e.eventId,
        kind: e.kind,
        providerRef: e.providerRef,
        amount: e.amount ? money(e.amount) : null,
        verified: e.verified,
        outcome: e.outcome,
        receivedAt: e.receivedAt,
      })),
    };
  }

  private async load(id: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new ProblemException(404, "NOT_FOUND", "Order not found");
    return order;
  }

  async hold(
    actor: StaffContext,
    id: string,
    input: { reason: string; reviewOn?: Date; note?: string },
    ctx: AuditContext,
  ) {
    const order = await this.load(id);
    if (order.status === "CANCELLED" || order.status === "DELIVERED")
      throw new ProblemException(409, "NOT_HOLDABLE", "This order can't be put on hold");
    if (order.onHold) throw new ProblemException(409, "ALREADY_ON_HOLD", "This order is already on hold");
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: { onHold: true, holdReason: input.reason, holdReviewOn: input.reviewOn ?? null },
      });
      await this.event(
        tx,
        id,
        "order.held",
        `Put on hold — ${input.reason}`,
        { kind: "staff", id: actor.user.id },
        {
          reviewOn: input.reviewOn ?? null,
          note: input.note ?? null,
        },
      );
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "orders.held",
        { type: "order", id },
        { after: { reason: input.reason, reviewOn: input.reviewOn ?? null, note: input.note ?? null } },
        tx,
      );
    }, TX);
    return this.adminOrder(id);
  }

  async release(actor: StaffContext, id: string, note: string | undefined, ctx: AuditContext) {
    const order = await this.load(id);
    if (!order.onHold) throw new ProblemException(409, "NOT_ON_HOLD", "This order isn't on hold");
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { onHold: false, holdReason: null, holdReviewOn: null } });
      await this.event(
        tx,
        id,
        "order.released",
        "Hold released",
        { kind: "staff", id: actor.user.id },
        { note: note ?? null },
      );
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "orders.released",
        { type: "order", id },
        { before: { reason: order.holdReason } },
        tx,
      );
    }, TX);
    return this.adminOrder(id);
  }

  /**
   * Cancels the whole order or some items. Items already in production can't be cancelled here.
   * When money was received, a refund for the cancelled items is requested (completed in Payments).
   */
  async cancel(
    actor: StaffContext,
    id: string,
    input: { reason: string; note?: string; itemIds?: string[] },
    ctx: AuditContext,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, payments: true, refunds: true },
    });
    if (!order) throw new ProblemException(404, "NOT_FOUND", "Order not found");
    if (order.status === "CANCELLED")
      throw new ProblemException(409, "ALREADY_CANCELLED", "This order is already cancelled");
    if (LOCKED.includes(order.status))
      throw new ProblemException(
        409,
        "IN_PRODUCTION",
        "This order is already in production and can't be cancelled here",
      );
    const active = order.items.filter((i) => i.status === "ACTIVE");
    const targets = input.itemIds ? active.filter((i) => input.itemIds!.includes(i.id)) : active;
    if (input.itemIds && targets.length !== input.itemIds.length)
      throw new ProblemException(422, "ITEMS_INVALID", "Some items aren't active items of this order");
    if (!targets.length) throw new ProblemException(422, "ITEMS_INVALID", "Choose at least one item to cancel");
    const everything = targets.length === active.length;
    const captured = order.payments.find((p) => p.status === "CAPTURED");
    const refundAmount = captured
      ? targets.reduce((sum, i) => sum.plus(i.lineTotal.toString()), new Decimal(0))
      : new Decimal(0);

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.orderItem.updateMany({
        where: { id: { in: targets.map((i) => i.id) } },
        data: { status: "CANCELLED", cancelledAt: now },
      });
      if (everything)
        await tx.order.update({
          where: { id },
          data: { status: "CANCELLED", cancelledAt: now, cancelReason: input.reason, onHold: false },
        });
      if (captured && refundAmount.gt(0))
        await tx.refund.create({
          data: {
            orderId: id,
            paymentId: captured.id,
            amount: refundAmount.toFixed(2),
            reason: `Cancelled: ${input.reason}`,
            requestedById: actor.user.id,
          },
        });
      const what = everything
        ? "Order cancelled"
        : `${targets.length} item${targets.length === 1 ? "" : "s"} cancelled`;
      await this.event(
        tx,
        id,
        everything ? "order.cancelled" : "items.cancelled",
        `${what} — ${input.reason}${refundAmount.gt(0) ? ` · refund of ₹${refundAmount.toFixed(2)} requested` : ""}`,
        { kind: "staff", id: actor.user.id },
        { items: targets.map((i) => i.productName), note: input.note ?? null },
      );
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        everything ? "orders.cancelled" : "orders.items_cancelled",
        { type: "order", id },
        {
          after: {
            reason: input.reason,
            note: input.note ?? null,
            items: targets.map((i) => i.id),
            refund: refundAmount.gt(0) ? refundAmount.toFixed(2) : null,
          },
        },
        tx,
      );
    }, TX);
    return this.adminOrder(id);
  }

  async exportCsv(filter: { status?: string; q?: string }) {
    const page = await this.adminList({ ...filter, page: 1, pageSize: 5000 });
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      // Neutralise spreadsheet formulas (CSV injection) and quote every field.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = ["Order", "Customer", "Placed", "Payment", "Status", "On hold", "Total (INR)"];
    const lines = page.items.map((o) =>
      [o.orderNumber, o.customer, o.placedAt.toISOString(), o.payment, o.status, o.onHold ? "yes" : "no", o.grandTotal]
        .map(esc)
        .join(","),
    );
    return [header.map(esc).join(","), ...lines].join("\r\n") + "\r\n";
  }
}
