import { Injectable } from "@nestjs/common";
import Decimal from "decimal.js";
import type { Prisma, QuoteStatus } from "@prisma/client";
import { AuditService, type AuditContext } from "../auth/audit.service";
import type { StaffContext } from "../auth/auth.service";
import { CatalogueService } from "../catalogue/catalogue.service";
import { normalisePhone } from "../commerce/customer-auth";
import { ProblemException } from "../common/problem";
import { priceConfiguration, type Configuration } from "../pricing/engine";
import { PrismaService } from "../prisma/prisma.service";

const money = (d: Prisma.Decimal | Decimal | string | number) => new Decimal(d.toString()).toFixed(2);
const unit = (d: Prisma.Decimal | Decimal | string | number) =>
  new Decimal(d.toString()).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const istYear = (at = new Date()) => new Date(at.getTime() + 5.5 * 3600_000).getUTCFullYear();

export type QuoteContact = { name: string; phone: string; email?: string | null };
export type LineInput = {
  productId?: string;
  config?: Configuration;
  description?: string;
  quantity?: number;
  /** Quoted unit price. Left out on a product line = the engine price. */
  unitPrice?: string;
  /** Free-text lines only: one of the catalogue's GST rates. */
  gstRate?: string;
};

const OPEN: QuoteStatus[] = ["REQUESTED", "UNDER_REVIEW", "SENT", "CLARIFICATION"];
/** Manual stage moves (AD-QUO-01). SENT is reached only by sending a revision. */
const MOVES: Record<QuoteStatus, QuoteStatus[]> = {
  REQUESTED: ["UNDER_REVIEW", "DECLINED"],
  UNDER_REVIEW: ["REQUESTED", "DECLINED"],
  SENT: ["CLARIFICATION", "ACCEPTED", "DECLINED"],
  CLARIFICATION: ["UNDER_REVIEW", "ACCEPTED", "DECLINED"],
  ACCEPTED: [],
  DECLINED: ["UNDER_REVIEW"],
};

const include = {
  lines: { orderBy: { sort: "asc" } },
  revisions: { orderBy: { revision: "desc" } },
  company: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.QuoteInclude;
type QuoteRow = Prisma.QuoteGetPayload<{ include: typeof include }>;

/** AD-QUO-01/02 · Bulk and corporate quotations. */
@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: CatalogueService,
    private readonly audit: AuditService,
  ) {}

  private async nextNumber(tx: Prisma.TransactionClient) {
    const year = istYear();
    const seq = await tx.quoteSequence.upsert({
      where: { year },
      update: { last: { increment: 1 } },
      create: { year, last: 1 },
    });
    return `Q-${year}-${String(seq.last).padStart(4, "0")}`;
  }

  private contact(input: QuoteContact) {
    const phone = normalisePhone(input.phone);
    if (!phone) throw new ProblemException(400, "PHONE_INVALID", "Enter a 10-digit Indian mobile number");
    return { name: input.name, phone, email: input.email?.trim().toLowerCase() || null };
  }

  private view(q: QuoteRow) {
    return {
      id: q.id,
      number: q.number,
      status: q.status,
      source: q.source,
      contact: q.contact,
      companyName: q.companyName,
      gstin: q.gstin,
      company: q.company,
      assignedTo: q.assignedTo,
      request: q.request,
      notes: q.notes,
      overrideReason: q.overrideReason,
      validUntil: q.validUntil,
      revision: q.revision,
      sentAt: q.sentAt,
      decidedAt: q.decidedAt,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
      /** Lines changed since the last revision was sent. */
      unsentChanges: q.revision > 0 && q.status !== "SENT" && q.status !== "ACCEPTED" && q.status !== "DECLINED",
      nextStatuses: MOVES[q.status],
      totals: { subtotal: money(q.subtotal), tax: money(q.taxTotal), total: money(q.grandTotal) },
      lines: q.lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        config: l.config,
        description: l.description,
        quantity: l.quantity,
        engineUnitPrice: l.engineUnitPrice ? unit(l.engineUnitPrice).toFixed(4) : null,
        unitPrice: unit(l.unitPrice).toFixed(4),
        /** Percentage change against the engine price; null when not overridden. */
        overridePercent:
          l.engineUnitPrice && !unit(l.engineUnitPrice).equals(unit(l.unitPrice)) && !unit(l.engineUnitPrice).isZero()
            ? unit(l.unitPrice).minus(unit(l.engineUnitPrice)).div(unit(l.engineUnitPrice)).times(100).toFixed(1)
            : null,
        gstRate: new Decimal(l.gstRate.toString()).toFixed(2),
        lineSubtotal: money(l.lineSubtotal),
        taxAmount: money(l.taxAmount),
        lineTotal: money(l.lineTotal),
      })),
      revisions: q.revisions.map((r) => ({ revision: r.revision, sentAt: r.sentAt, snapshot: r.snapshot })),
    };
  }

  // ------------------------------------------------------------ reading

  async list(filter: { q?: string; status?: QuoteStatus }) {
    const term = filter.q?.trim();
    const rows = await this.prisma.quote.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(term
          ? {
              OR: [
                { number: { contains: term, mode: "insensitive" } },
                { companyName: { contains: term, mode: "insensitive" } },
                { contact: { path: ["name"], string_contains: term } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 300,
      include: { lines: { orderBy: { sort: "asc" } }, assignedTo: { select: { id: true, name: true } } },
    });
    return rows.map((q) => ({
      id: q.id,
      number: q.number,
      status: q.status,
      source: q.source,
      name: q.companyName || (q.contact as QuoteContact).name,
      summary: q.lines.length
        ? `${q.lines.length} ${q.lines.length === 1 ? "item" : "items"} · ${q.lines
            .slice(0, 2)
            .map((l) => `${l.quantity.toLocaleString("en-IN")} × ${l.description.split(" · ")[0]}`)
            .join(", ")}`
        : "No lines yet",
      total: q.lines.length ? money(q.grandTotal) : null,
      revision: q.revision,
      validUntil: q.validUntil,
      assignedTo: q.assignedTo,
      updatedAt: q.updatedAt,
    }));
  }

  async get(id: string) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include });
    if (!q) throw new ProblemException(404, "QUOTE_NOT_FOUND", "Quotation not found");
    return this.view(q);
  }

  /** What the editor needs: who can own a quote, products to quote, and the GST rates in use. */
  async options() {
    const [staff, products, taxes] = await Promise.all([
      this.prisma.user.findMany({
        where: { kind: "STAFF", staffStatus: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.product.findMany({
        where: { isVisible: true, pricingVersions: { some: { status: "PUBLISHED" } } },
        select: { id: true, name: true, slug: true },
        orderBy: { sort: "asc" },
      }),
      this.prisma.taxProfile.findMany({ select: { gstRate: true } }),
    ]);
    const rates = [...new Set(taxes.map((t) => new Decimal(t.gstRate.toString()).toFixed(2)))].sort(
      (a, b) => Number(a) - Number(b),
    );
    return { assignees: staff, products, gstRates: rates };
  }

  /** A product's option groups, for building a quote line. */
  async productOptions(productId: string) {
    const p = await this.prisma.product.findUnique({ where: { id: productId }, select: { slug: true } });
    if (!p) throw new ProblemException(404, "PRODUCT_NOT_FOUND", "Product not found");
    const { row, doc } = await this.catalogue.load(p.slug);
    return {
      id: row.id,
      name: row.name,
      quantityMode: row.quantityMode,
      sizes: row.sizes,
      minimumQuantity: doc.tiers[0].minQty,
      unit: { one: row.unitOne, many: row.unitMany },
      groups: row.optionGroups.map((g) => ({
        key: g.key,
        label: g.shortLabel ?? g.label,
        kind: g.kind,
        defaults: g.defaultKeys,
        options: g.options.filter((o) => o.isAvailable).map((o) => ({ key: o.key, label: o.label })),
      })),
    };
  }

  // ------------------------------------------------------------ creating

  /** A request from the storefront's bulk-quote form. Nothing is priced until staff review it. */
  async requestFromWeb(input: {
    contact: QuoteContact;
    companyName?: string;
    gstin?: string;
    items: { productSlug: string; quantity: number; notes?: string }[];
    needBy?: string;
    notes?: string;
  }) {
    const contact = this.contact(input.contact);
    const products = await this.prisma.product.findMany({
      where: { slug: { in: input.items.map((i) => i.productSlug) } },
      select: { slug: true, name: true },
    });
    const items = input.items.map((i) => ({
      ...i,
      productName: products.find((p) => p.slug === i.productSlug)?.name ?? i.productSlug,
    }));
    const customer = await this.prisma.user.findFirst({ where: { phoneE164: contact.phone, kind: "CUSTOMER" } });
    const quote = await this.prisma.$transaction(
      async (tx) =>
        tx.quote.create({
          data: {
            number: await this.nextNumber(tx),
            source: "web",
            contact,
            companyName: input.companyName || null,
            gstin: input.gstin || null,
            customerId: customer?.id ?? null,
            request: { items, needBy: input.needBy ?? null, notes: input.notes ?? null } as Prisma.InputJsonValue,
          },
        }),
      { timeout: 20_000 },
    );
    await this.audit.record({ actorKind: "system" }, "quote.requested", { type: "quote", id: quote.id });
    return { number: quote.number };
  }

  async create(
    actor: StaffContext,
    input: { contact: QuoteContact; companyName?: string; gstin?: string; companyId?: string },
    ctx: AuditContext,
  ) {
    const contact = this.contact(input.contact);
    const company = input.companyId ? await this.prisma.company.findUnique({ where: { id: input.companyId } }) : null;
    if (input.companyId && !company) throw new ProblemException(404, "COMPANY_NOT_FOUND", "Company not found");
    const customer = await this.prisma.user.findFirst({ where: { phoneE164: contact.phone, kind: "CUSTOMER" } });
    const quote = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.quote.create({
          data: {
            number: await this.nextNumber(tx),
            source: "staff",
            status: "UNDER_REVIEW",
            contact,
            companyName: input.companyName || company?.name || null,
            gstin: input.gstin || company?.gstin || null,
            companyId: company?.id ?? null,
            customerId: customer?.id ?? null,
            assignedToId: actor.user.id,
          },
        });
        await this.audit.record(
          { ...ctx, actorId: actor.user.id },
          "quote.created",
          { type: "quote", id: created.id },
          { after: { number: created.number } },
          tx,
        );
        return created;
      },
      { timeout: 20_000 },
    );
    return this.get(quote.id);
  }

  // ------------------------------------------------------------ editing

  private async editable(id: string) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include: { lines: true } });
    if (!q) throw new ProblemException(404, "QUOTE_NOT_FOUND", "Quotation not found");
    if (!OPEN.includes(q.status))
      throw new ProblemException(
        409,
        "QUOTE_CLOSED",
        `This quotation is ${q.status.toLowerCase()} and can't be changed`,
      );
    return q;
  }

  async update(
    actor: StaffContext,
    id: string,
    input: {
      contact?: QuoteContact;
      companyName?: string | null;
      gstin?: string | null;
      companyId?: string | null;
      assignedToId?: string | null;
      notes?: string | null;
      overrideReason?: string | null;
      validUntil?: string | null;
    },
    ctx: AuditContext,
  ) {
    await this.editable(id);
    if (input.assignedToId) {
      const staff = await this.prisma.user.findFirst({
        where: { id: input.assignedToId, kind: "STAFF", staffStatus: "ACTIVE" },
      });
      if (!staff) throw new ProblemException(400, "ASSIGNEE_INVALID", "Choose an active staff member");
    }
    if (input.companyId && !(await this.prisma.company.findUnique({ where: { id: input.companyId } })))
      throw new ProblemException(404, "COMPANY_NOT_FOUND", "Company not found");
    await this.prisma.quote.update({
      where: { id },
      data: {
        contact: input.contact ? this.contact(input.contact) : undefined,
        companyName: input.companyName,
        gstin: input.gstin === undefined ? undefined : input.gstin?.toUpperCase() || null,
        companyId: input.companyId,
        assignedToId: input.assignedToId,
        notes: input.notes,
        overrideReason: input.overrideReason,
        validUntil: input.validUntil === undefined ? undefined : input.validUntil ? new Date(input.validUntil) : null,
      },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "quote.updated",
      { type: "quote", id },
      { after: input },
    );
    return this.get(id);
  }

  /**
   * Prices one line. Product lines get the engine price for the chosen options and quantity
   * (the list price, even above the product's online quote threshold); a different quoted
   * price is an override. Free-text lines carry their own price and one of the catalogue GST rates.
   */
  private async priceLine(line: LineInput, sort: number, gstRates: Set<string>) {
    if (line.productId) {
      const p = await this.prisma.product.findUnique({ where: { id: line.productId }, select: { slug: true } });
      if (!p) throw new ProblemException(400, "PRODUCT_NOT_FOUND", `Line ${sort + 1}: product not found`);
      const product = await this.catalogue.load(p.slug);
      const config = line.config ?? { selections: {} };
      const result = priceConfiguration(product.engine, { ...product.doc, quoteFromQty: undefined }, config);
      if (!result.valid || !result.subtotal)
        throw new ProblemException(
          422,
          "LINE_INVALID",
          `Line ${sort + 1} (${product.row.name}) can't be priced`,
          result.errors.map((e) => e.message).join(" "),
        );
      const engineUnit = unit(new Decimal(result.subtotal).div(result.quantity));
      const quoted = line.unitPrice !== undefined ? unit(line.unitPrice) : engineUnit;
      const overridden = !quoted.equals(engineUnit);
      const subtotal = overridden ? round2(quoted.times(result.quantity)) : new Decimal(result.subtotal);
      const labels = product.row.optionGroups.flatMap((g) => {
        const raw = config.selections[g.key];
        const keys = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        return keys.map((k) => g.options.find((o) => o.key === k)?.label).filter(Boolean);
      });
      return {
        overridden,
        data: {
          sort,
          productId: product.row.id,
          config: config as unknown as Prisma.InputJsonValue,
          description: line.description?.trim() || [product.row.name, ...labels].join(" · "),
          quantity: result.quantity,
          engineUnitPrice: engineUnit,
          unitPrice: quoted,
          gstRate: new Decimal(product.engine.gstRate),
          lineSubtotal: subtotal,
        },
      };
    }
    if (!line.description?.trim() || !line.quantity || line.unitPrice === undefined || !line.gstRate)
      throw new ProblemException(
        400,
        "LINE_INCOMPLETE",
        `Line ${sort + 1} needs a description, quantity, unit price and GST rate`,
      );
    const rate = new Decimal(line.gstRate).toFixed(2);
    if (!gstRates.has(rate))
      throw new ProblemException(400, "GST_RATE_INVALID", `Line ${sort + 1}: choose one of the catalogue's GST rates`);
    return {
      overridden: false,
      data: {
        sort,
        productId: null,
        config: undefined,
        description: line.description.trim(),
        quantity: line.quantity,
        engineUnitPrice: null,
        unitPrice: unit(line.unitPrice),
        gstRate: new Decimal(rate),
        lineSubtotal: round2(unit(line.unitPrice).times(line.quantity)),
      },
    };
  }

  /** Replaces the quote's lines and recomputes totals. Changing a sent quote moves it back to review. */
  async setLines(
    actor: StaffContext,
    id: string,
    lines: LineInput[],
    overrideReason: string | undefined,
    ctx: AuditContext,
  ) {
    const before = await this.editable(id);
    const { gstRates } = await this.options();
    const priced = [];
    for (const [i, line] of lines.entries()) priced.push(await this.priceLine(line, i, new Set(gstRates)));
    const overrides = priced.filter((p) => p.overridden);
    const reason = (overrideReason ?? before.overrideReason ?? "").trim();
    if (overrides.length) {
      if (!actor.permissions.has("quotes.override_price"))
        throw new ProblemException(
          403,
          "OVERRIDE_NOT_ALLOWED",
          "Changing the engine price needs the quotes.override_price permission",
        );
      if (reason.length < 5)
        throw new ProblemException(400, "OVERRIDE_REASON_REQUIRED", "Give a reason for the price override");
    }
    const rows = priced.map(({ data }) => {
      const tax = round2(data.lineSubtotal.times(data.gstRate).div(100));
      return { ...data, taxAmount: tax, lineTotal: data.lineSubtotal.plus(tax) };
    });
    const subtotal = rows.reduce((s, r) => s.plus(r.lineSubtotal), new Decimal(0));
    const tax = rows.reduce((s, r) => s.plus(r.taxAmount), new Decimal(0));
    await this.prisma.$transaction(
      async (tx) => {
        await tx.quoteLine.deleteMany({ where: { quoteId: id } });
        await tx.quoteLine.createMany({ data: rows.map((r) => ({ ...r, quoteId: id })) });
        await tx.quote.update({
          where: { id },
          data: {
            subtotal,
            taxTotal: tax,
            grandTotal: subtotal.plus(tax),
            overrideReason: overrides.length ? reason : before.overrideReason,
            status: before.status === "SENT" || before.status === "REQUESTED" ? "UNDER_REVIEW" : before.status,
            assignedToId: before.assignedToId ?? actor.user.id,
          },
        });
        await this.audit.record(
          { ...ctx, actorId: actor.user.id },
          overrides.length ? "quote.price_overridden" : "quote.lines_changed",
          { type: "quote", id },
          {
            before: { total: money(before.grandTotal), lines: before.lines.length },
            after: {
              total: money(subtotal.plus(tax)),
              lines: rows.length,
              ...(overrides.length
                ? {
                    reason,
                    overrides: overrides.map((o) => ({
                      line: o.data.description,
                      engine: o.data.engineUnitPrice?.toFixed(4),
                      quoted: o.data.unitPrice.toFixed(4),
                    })),
                  }
                : {}),
            },
          },
          tx,
        );
      },
      { timeout: 20_000 },
    );
    return this.get(id);
  }

  /**
   * Records a revision as sent: freezes what was quoted. Delivery to the customer is manual
   * until an email / SMS provider is chosen (D-25).
   */
  async send(actor: StaffContext, id: string, ctx: AuditContext) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include });
    if (!q) throw new ProblemException(404, "QUOTE_NOT_FOUND", "Quotation not found");
    if (q.status !== "UNDER_REVIEW" && q.status !== "CLARIFICATION")
      throw new ProblemException(
        409,
        "QUOTE_NOT_READY",
        "Only a quotation under review or in clarification can be sent",
      );
    if (!q.lines.length) throw new ProblemException(400, "QUOTE_EMPTY", "Add at least one line before sending");
    if (!q.validUntil || q.validUntil.getTime() < Date.now())
      throw new ProblemException(400, "VALIDITY_REQUIRED", "Set a 'valid until' date in the future");
    const revision = q.revision + 1;
    const view = this.view(q);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.quoteRevision.create({
          data: {
            quoteId: id,
            revision,
            sentById: actor.user.id,
            snapshot: {
              lines: view.lines,
              totals: view.totals,
              validUntil: q.validUntil,
              contact: q.contact,
              companyName: q.companyName,
              gstin: q.gstin,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.quote.update({ where: { id }, data: { revision, status: "SENT", sentAt: new Date() } });
        await this.audit.record(
          { ...ctx, actorId: actor.user.id },
          "quote.sent",
          { type: "quote", id },
          { after: { revision, total: view.totals.total } },
          tx,
        );
      },
      { timeout: 20_000 },
    );
    return this.get(id);
  }

  async move(actor: StaffContext, id: string, status: QuoteStatus, ctx: AuditContext) {
    const q = await this.prisma.quote.findUnique({ where: { id } });
    if (!q) throw new ProblemException(404, "QUOTE_NOT_FOUND", "Quotation not found");
    if (!MOVES[q.status].includes(status))
      throw new ProblemException(
        409,
        "MOVE_NOT_ALLOWED",
        `A ${q.status.toLowerCase().replace("_", " ")} quotation can't move to ${status.toLowerCase().replace("_", " ")}`,
      );
    await this.prisma.quote.update({
      where: { id },
      data: {
        status,
        decidedAt: status === "ACCEPTED" || status === "DECLINED" ? new Date() : null,
        assignedToId: q.assignedToId ?? actor.user.id,
      },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "quote.moved",
      { type: "quote", id },
      { before: { status: q.status }, after: { status } },
    );
    return this.get(id);
  }
}
