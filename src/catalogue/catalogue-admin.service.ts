import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { AuditService, type AuditContext } from "../auth/audit.service";
import type { StaffContext } from "../auth/auth.service";
import { decimalString } from "../common/money";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { priceConfiguration, type Configuration } from "../pricing/engine";
import { parsePricingDocument, type PricingDocument } from "../pricing/pricing-document";
import { engineProductFor } from "./catalogue.service";
import { PricingActivation } from "./pricing-activation";

/** Neon runs in another region: give interactive transactions room. */
const TX = { timeout: 20_000, maxWait: 10_000 };

const productDetail = {
  category: { select: { id: true, slug: true, name: true } },
  taxProfile: { select: { name: true, gstRate: true } },
  optionGroups: { orderBy: { stepOrder: "asc" }, include: { options: { orderBy: { sort: "asc" } } } },
  artworkSlots: { orderBy: { sort: "asc" } },
  optionRules: { orderBy: { sort: "asc" } },
} satisfies Prisma.ProductInclude;
type ProductDetail = Prisma.ProductGetPayload<{ include: typeof productDetail }>;

export type CategoryInput = { slug: string; name: string; summary: string; lead?: string; about?: string };
export type CategoryPatch = Partial<Omit<CategoryInput, "slug">> & { isVisible?: boolean };
export type ProductPatch = {
  name?: string;
  summary?: string;
  lead?: string;
  description?: string;
  categoryId?: string;
  unitOne?: string;
  unitMany?: string;
  turnaroundMinDays?: number;
  turnaroundMaxDays?: number;
  uploadTiming?: "BEFORE_CART" | "AFTER_CHECKOUT" | "EITHER";
  imageUrl?: string;
  isVisible?: boolean;
};
export type OptionPatch = {
  label?: string;
  detail?: string | null;
  isAvailable?: boolean;
  unavailableReason?: string | null;
};
export type SlotPatch = {
  label?: string;
  printArea?: string;
  bleedMm?: string | null;
  safeMm?: string | null;
  acceptedTypes?: string[];
  maxMb?: number;
};

export type DiffRow = {
  component: string;
  label: string;
  before: string | null;
  after: string | null;
  change: string | null;
};

export const notFound = (what: string) => new ProblemException(404, "NOT_FOUND", `${what} not found`);

export function requirePublish(actor: StaffContext, permission: string, what = "Showing or hiding") {
  if (!actor.permissions.has(permission))
    throw new ProblemException(
      403,
      "FORBIDDEN",
      "You don't have permission to do this",
      `${what} needs the "${permission}" permission.`,
    );
}

/** A new product starts pricing from this template; every price must be entered before publishing. */
const STARTER_DOCUMENT = {
  currency: "INR",
  source: "Prices entered by staff — confirm before publishing",
  tiers: [{ minQty: 1, unitPrice: "0.00" }],
  options: {},
  setupCharges: [],
};

/** Percent change between two decimal strings, e.g. "+3.3%". */
function change(before: string | null, after: string | null): string | null {
  if (before === after) return null;
  if (before === null) return "New";
  if (after === null) return "Removed";
  const b = new Decimal(before);
  if (b.isZero()) return "Changed";
  const pct = new Decimal(after).minus(b).div(b).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
  return `${pct.isPositive() && !pct.isZero() ? "+" : ""}${pct.toFixed(1)}%`;
}

const money2 = (value: string | undefined | null) => {
  if (value == null) return null;
  const d = new Decimal(value);
  return d.toFixed(Math.max(2, d.decimalPlaces()));
};

/**
 * Admin side of the catalogue and pricing (AD-CAT-01…03, AD-PRC-01…03). Every write is
 * audited. Pricing changes are versioned: edit a draft, test it, then publish it; the
 * previous published version is archived in the same transaction.
 */
@Injectable()
export class CatalogueAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly activation: PricingActivation,
  ) {}

  // ---------- categories ----------

  async listCategories() {
    const rows = await this.prisma.category.findMany({
      orderBy: { sort: "asc" },
      include: { _count: { select: { products: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      lead: row.lead,
      about: row.about,
      imageUrl: row.imageUrl,
      sort: row.sort,
      isVisible: row.isVisible,
      productCount: row._count.products,
    }));
  }

  async createCategory(actor: StaffContext, input: CategoryInput, ctx: AuditContext) {
    if (await this.prisma.category.findUnique({ where: { slug: input.slug } }))
      throw new ProblemException(409, "SLUG_TAKEN", "That URL slug is already used", `"${input.slug}" is taken.`);
    const last = await this.prisma.category.aggregate({ _max: { sort: true } });
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.category.create({
        data: {
          slug: input.slug,
          name: input.name,
          summary: input.summary,
          lead: input.lead ?? "",
          about: input.about ?? "",
          imageUrl: "",
          sort: (last._max.sort ?? -1) + 1,
          // New categories stay hidden until someone with catalogue.publish shows them.
          isVisible: false,
        },
      });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.category_created",
        { type: "category", id: created.id },
        { after: { slug: created.slug, name: created.name } },
        tx,
      );
      return created;
    }, TX);
    return (await this.listCategories()).find((c) => c.id === row.id);
  }

  async updateCategory(actor: StaffContext, id: string, patch: CategoryPatch, ctx: AuditContext) {
    const before = await this.prisma.category.findUnique({ where: { id } });
    if (!before) throw notFound("Category");
    if (patch.isVisible !== undefined && patch.isVisible !== before.isVisible)
      requirePublish(actor, "catalogue.publish");
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.category.update({ where: { id }, data: patch });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.category_updated",
        { type: "category", id },
        { before: pick(before, Object.keys(patch)), after: pick(after, Object.keys(patch)) },
        tx,
      );
    }, TX);
    return (await this.listCategories()).find((c) => c.id === id);
  }

  async reorderCategories(actor: StaffContext, ids: string[], ctx: AuditContext) {
    const all = await this.prisma.category.findMany({ select: { id: true }, orderBy: { sort: "asc" } });
    const known = new Set(all.map((c) => c.id));
    if (ids.length !== all.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
      throw new ProblemException(422, "ORDER_INVALID", "Send every category exactly once");
    await this.prisma.$transaction(async (tx) => {
      for (const [sort, id] of ids.entries()) await tx.category.update({ where: { id }, data: { sort } });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.categories_reordered",
        { type: "category", id: ids[0] },
        { before: all.map((c) => c.id), after: ids },
        tx,
      );
    }, TX);
    return this.listCategories();
  }

  async deleteCategory(actor: StaffContext, id: string, ctx: AuditContext) {
    const row = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!row) throw notFound("Category");
    if (row._count.products > 0)
      throw new ProblemException(
        409,
        "CATEGORY_NOT_EMPTY",
        "This category still has products",
        "Move its products to another category first.",
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.category.delete({ where: { id } });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.category_deleted",
        { type: "category", id },
        { before: { slug: row.slug, name: row.name } },
        tx,
      );
    }, TX);
    return { deleted: true };
  }

  // ---------- products ----------

  async listProducts() {
    await this.activation.activateDue();
    const rows = await this.prisma.product.findMany({
      orderBy: { sort: "asc" },
      include: {
        category: { select: { id: true, slug: true, name: true } },
        artworkSlots: { orderBy: { sort: "asc" }, select: { label: true } },
        pricingVersions: {
          where: { status: { in: ["PUBLISHED", "DRAFT", "SCHEDULED"] } },
          select: { status: true, versionNo: true, effectiveFrom: true },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      category: row.category,
      isVisible: row.isVisible,
      publishedVersionNo: row.pricingVersions.find((v) => v.status === "PUBLISHED")?.versionNo ?? null,
      draftVersionNo: row.pricingVersions.find((v) => v.status === "DRAFT")?.versionNo ?? null,
      scheduled: (() => {
        const v = row.pricingVersions.find((x) => x.status === "SCHEDULED");
        return v ? { versionNo: v.versionNo, effectiveFrom: v.effectiveFrom } : null;
      })(),
      artworkSlots: row.artworkSlots.map((slot) => slot.label),
    }));
  }

  async getProduct(id: string) {
    const row = await this.prisma.product.findUnique({ where: { id }, include: productDetail });
    if (!row) throw notFound("Product");
    const published = await this.prisma.pricingVersion.findFirst({
      where: { productId: id, status: "PUBLISHED" },
      select: { versionNo: true },
    });
    return this.detail(row, published?.versionNo ?? null);
  }

  private detail(row: ProductDetail, publishedVersionNo: number | null) {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      lead: row.lead,
      description: row.description,
      imageUrl: row.imageUrl,
      category: row.category,
      isVisible: row.isVisible,
      unitOne: row.unitOne,
      unitMany: row.unitMany,
      turnaroundMinDays: row.turnaroundMinDays,
      turnaroundMaxDays: row.turnaroundMaxDays,
      quantityMode: row.quantityMode,
      sizes: row.sizes,
      uploadTiming: row.uploadTiming,
      taxProfile: { name: row.taxProfile.name, gstRate: row.taxProfile.gstRate.toFixed(2) },
      publishedVersionNo,
      optionGroups: row.optionGroups.map((group) => ({
        id: group.id,
        key: group.key,
        label: group.label,
        shortLabel: group.shortLabel,
        hint: group.hint,
        note: group.note,
        kind: group.kind,
        required: group.required,
        defaultKeys: group.defaultKeys,
        options: group.options.map((option) => ({
          id: option.id,
          key: option.key,
          label: option.label,
          detail: option.detail,
          swatch: option.swatch,
          isAvailable: option.isAvailable,
          unavailableReason: option.unavailableReason,
        })),
      })),
      artworkSlots: row.artworkSlots.map((slot) => ({
        id: slot.id,
        key: slot.key,
        label: slot.label,
        printArea: slot.printArea,
        bleedMm: decimalString(slot.bleedMm, 1),
        safeMm: decimalString(slot.safeMm, 1),
        acceptedTypes: slot.acceptedTypes,
        maxMb: slot.maxMb,
      })),
      rules: row.optionRules.map((rule) => ({
        id: rule.id,
        whenGroup: rule.whenGroup,
        whenOption: rule.whenOption,
        effect: rule.effect,
        thenGroup: rule.thenGroup,
        thenOptions: rule.thenOptions,
        message: rule.message,
      })),
    };
  }

  async updateProduct(actor: StaffContext, id: string, patch: ProductPatch, ctx: AuditContext) {
    const before = await this.prisma.product.findUnique({ where: { id } });
    if (!before) throw notFound("Product");
    if (patch.isVisible !== undefined && patch.isVisible !== before.isVisible) {
      requirePublish(actor, "catalogue.publish");
      if (patch.isVisible) {
        const published = await this.prisma.pricingVersion.count({ where: { productId: id, status: "PUBLISHED" } });
        if (!published)
          throw new ProblemException(
            409,
            "NO_PUBLISHED_PRICING",
            "This product has no published pricing",
            "Publish a pricing version before showing it on the site.",
          );
        if (!(patch.imageUrl ?? before.imageUrl))
          throw new ProblemException(409, "NO_IMAGE", "This product has no image", "Choose a product image first.");
        const slots = await this.prisma.artworkSlot.count({ where: { productId: id } });
        if (!slots)
          throw new ProblemException(
            409,
            "NO_ARTWORK_SLOT",
            "This product has no artwork slot",
            "Add an artwork slot first.",
          );
      }
    }
    if (patch.categoryId && !(await this.prisma.category.findUnique({ where: { id: patch.categoryId } })))
      throw new ProblemException(422, "CATEGORY_UNKNOWN", "Choose an existing category");
    const min = patch.turnaroundMinDays ?? before.turnaroundMinDays;
    const max = patch.turnaroundMaxDays ?? before.turnaroundMaxDays;
    if (min > max)
      throw new ProblemException(422, "TURNAROUND_INVALID", "Turnaround: the minimum days can't exceed the maximum");
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.product.update({ where: { id }, data: patch });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.product_updated",
        { type: "product", id },
        { before: pick(before, Object.keys(patch)), after: pick(after, Object.keys(patch)) },
        tx,
      );
    }, TX);
    return this.getProduct(id);
  }

  async updateOption(actor: StaffContext, id: string, patch: OptionPatch, ctx: AuditContext) {
    const before = await this.prisma.option.findUnique({ where: { id }, include: { group: true } });
    if (!before) throw notFound("Option");
    const data = { ...patch };
    if (patch.isAvailable === true) data.unavailableReason = null;
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.option.update({ where: { id }, data });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.option_updated",
        { type: "option", id },
        { before: pick(before, Object.keys(data)), after: pick(after, Object.keys(data)) },
        tx,
      );
    }, TX);
    return this.getProduct(before.group.productId);
  }

  async updateArtworkSlot(actor: StaffContext, id: string, patch: SlotPatch, ctx: AuditContext) {
    const before = await this.prisma.artworkSlot.findUnique({ where: { id } });
    if (!before) throw notFound("Artwork slot");
    await this.prisma.$transaction(async (tx) => {
      const after = await tx.artworkSlot.update({ where: { id }, data: patch });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "catalogue.artwork_slot_updated",
        { type: "artwork_slot", id },
        { before: plain(pick(before, Object.keys(patch))), after: plain(pick(after, Object.keys(patch))) },
        tx,
      );
    }, TX);
    return this.getProduct(before.productId);
  }

  // ---------- pricing ----------

  async listVersions(productId: string) {
    await this.activation.activateDue();
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, slug: true, name: true },
    });
    if (!product) throw notFound("Product");
    const versions = await this.prisma.pricingVersion.findMany({
      where: { productId },
      orderBy: { versionNo: "desc" },
    });
    // Who published each version comes from the audit log (the version row has no actor column).
    const events = await this.prisma.auditLog.findMany({
      where: {
        action: { in: ["pricing.version_published", "pricing.version_scheduled"] },
        targetId: { in: versions.map((v) => v.id) },
      },
      select: { targetId: true, actorId: true },
    });
    const actors = await this.prisma.user.findMany({
      where: { id: { in: events.map((e) => e.actorId).filter((id): id is string => !!id) } },
      select: { id: true, name: true },
    });
    const byVersion = new Map(events.map((e) => [e.targetId, actors.find((a) => a.id === e.actorId)?.name ?? null]));
    return {
      product,
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        note: v.note,
        source: (v.document as { source?: string } | null)?.source ?? null,
        createdAt: v.createdAt,
        effectiveFrom: v.status === "DRAFT" ? null : v.effectiveFrom,
        effectiveTo: v.effectiveTo,
        publishedAt: v.publishedAt,
        publishedBy: byVersion.get(v.id) ?? null,
      })),
    };
  }

  async getVersion(versionId: string) {
    const version = await this.prisma.pricingVersion.findUnique({ where: { id: versionId } });
    if (!version) throw notFound("Pricing version");
    return {
      id: version.id,
      productId: version.productId,
      versionNo: version.versionNo,
      status: version.status,
      note: version.note,
      document: version.document,
      publishedAt: version.publishedAt,
      product: await this.getProduct(version.productId),
    };
  }

  async createDraft(actor: StaffContext, productId: string, ctx: AuditContext) {
    const product = await this.prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw notFound("Product");
    const existing = await this.prisma.pricingVersion.findFirst({
      where: { productId, status: { in: ["DRAFT", "SCHEDULED"] } },
    });
    if (existing?.status === "DRAFT")
      throw new ProblemException(409, "DRAFT_EXISTS", "This product already has a draft", undefined, {
        versionId: existing.id,
      });
    if (existing)
      throw new ProblemException(
        409,
        "VERSION_SCHEDULED",
        "A version is already scheduled",
        "Cancel the scheduled version to start a new draft.",
        { versionId: existing.id },
      );
    // A product without published pricing starts from an empty template (prices must be entered).
    const published = await this.prisma.pricingVersion.findFirst({ where: { productId, status: "PUBLISHED" } });
    const draft = await this.prisma.$transaction(async (tx) => {
      const last = await tx.pricingVersion.aggregate({ where: { productId }, _max: { versionNo: true } });
      const created = await tx.pricingVersion.create({
        data: {
          productId,
          versionNo: (last._max.versionNo ?? 0) + 1,
          status: "DRAFT",
          document: (published?.document ?? STARTER_DOCUMENT) as Prisma.InputJsonValue,
          note: null,
        },
      });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "pricing.draft_created",
        { type: "pricing_version", id: created.id },
        { after: { productId, versionNo: created.versionNo, from: published?.versionNo ?? null } },
        tx,
      );
      return created;
    }, TX);
    return this.getVersion(draft.id);
  }

  private async draft(versionId: string) {
    const version = await this.prisma.pricingVersion.findUnique({ where: { id: versionId } });
    if (!version) throw notFound("Pricing version");
    if (version.status !== "DRAFT")
      throw new ProblemException(409, "NOT_A_DRAFT", "Only a draft can be changed", "Start a new draft instead.");
    return version;
  }

  async saveDraft(
    actor: StaffContext,
    versionId: string,
    input: { document: unknown; note?: string | null },
    ctx: AuditContext,
  ) {
    const version = await this.draft(versionId);
    const doc = parsePricingDocument(input.document);
    await this.checkReferences(version.productId, doc);
    await this.prisma.$transaction(async (tx) => {
      await tx.pricingVersion.update({
        where: { id: versionId },
        data: { document: doc as Prisma.InputJsonValue, ...(input.note !== undefined ? { note: input.note } : {}) },
      });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "pricing.draft_saved",
        { type: "pricing_version", id: versionId },
        { before: version.document, after: doc },
        tx,
      );
    }, TX);
    return this.getVersion(versionId);
  }

  async discardDraft(actor: StaffContext, versionId: string, ctx: AuditContext) {
    const version = await this.draft(versionId);
    await this.prisma.$transaction(async (tx) => {
      await tx.pricingVersion.delete({ where: { id: versionId } });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "pricing.draft_discarded",
        { type: "pricing_version", id: versionId },
        { before: { productId: version.productId, versionNo: version.versionNo } },
        tx,
      );
    }, TX);
    return { deleted: true };
  }

  /** Every option, group and size the document prices must exist on the product. */
  private async checkReferences(productId: string, doc: PricingDocument) {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { optionGroups: { include: { options: true } } },
    });
    const groups = new Map(product.optionGroups.map((g) => [g.key, new Set(g.options.map((o) => o.key))]));
    const problems: string[] = [];
    for (const [groupKey, options] of Object.entries(doc.options)) {
      const known = groups.get(groupKey);
      if (!known) {
        problems.push(`Option prices: unknown option group "${groupKey}"`);
        continue;
      }
      for (const optionKey of Object.keys(options))
        if (!known.has(optionKey)) problems.push(`Option prices: unknown option "${optionKey}" in "${groupKey}"`);
    }
    for (const charge of doc.setupCharges) {
      if (!groups.has(charge.group)) problems.push(`Setup charge "${charge.label}": unknown group "${charge.group}"`);
      if (!groups.get(charge.appliesWhen.group)?.has(charge.appliesWhen.option))
        problems.push(
          `Setup charge "${charge.label}": unknown option "${charge.appliesWhen.option}" in "${charge.appliesWhen.group}"`,
        );
    }
    for (const size of doc.sizeSurcharge?.sizes ?? [])
      if (!product.sizes.includes(size)) problems.push(`Size surcharge: unknown size "${size}"`);
    if (doc.quoteFromQty !== undefined && doc.quoteFromQty <= doc.tiers[0].minQty)
      problems.push("The bulk-quote quantity must be above the minimum order quantity");
    if (problems.length)
      throw new ProblemException(422, "PRICING_INVALID", "The pricing doesn't match this product", undefined, {
        problems,
      });
  }

  /** Draft (or any version) compared with the currently published version. */
  async diff(versionId: string) {
    const version = await this.prisma.pricingVersion.findUnique({ where: { id: versionId } });
    if (!version) throw notFound("Pricing version");
    const published = await this.prisma.pricingVersion.findFirst({
      where: { productId: version.productId, status: "PUBLISHED" },
    });
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: version.productId },
      include: { optionGroups: { orderBy: { stepOrder: "asc" }, include: { options: { orderBy: { sort: "asc" } } } } },
    });
    const after = parsePricingDocument(version.document);
    const before = published && published.id !== version.id ? parsePricingDocument(published.document) : null;
    return {
      against: before && published ? { id: published.id, versionNo: published.versionNo } : null,
      rows: before ? diffDocuments(before, after, product) : [],
    };
  }

  async test(versionId: string, config: Configuration) {
    const version = await this.prisma.pricingVersion.findUnique({ where: { id: versionId } });
    if (!version) throw notFound("Pricing version");
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: version.productId },
      include: {
        taxProfile: { select: { gstRate: true } },
        optionGroups: { orderBy: { stepOrder: "asc" }, include: { options: { orderBy: { sort: "asc" } } } },
        optionRules: { orderBy: { sort: "asc" } },
      },
    });
    return {
      versionId,
      versionNo: version.versionNo,
      ...priceConfiguration(engineProductFor(product), parsePricingDocument(version.document), config),
    };
  }

  /**
   * Publish a draft now, or schedule it: a future `effectiveFrom` makes it SCHEDULED and it
   * goes live on the first catalogue read after that time (see PricingActivation).
   */
  async publish(actor: StaffContext, versionId: string, input: { effectiveFrom?: Date }, ctx: AuditContext) {
    const version = await this.draft(versionId);
    const doc = parsePricingDocument(version.document);
    await this.checkReferences(version.productId, doc);
    if (doc.tiers.some((tier) => new Decimal(tier.unitPrice).isZero()))
      throw new ProblemException(422, "PRICING_INVALID", "Every quantity tier needs a price", undefined, {
        problems: ["A tier still has a unit price of 0.00"],
      });
    const at = input.effectiveFrom;
    if (at && at.getTime() > Date.now() + 60_000) {
      if (at.getTime() > Date.now() + 366 * 24 * 3600_000)
        throw new ProblemException(422, "SCHEDULE_TOO_FAR", "Schedule within the next 12 months");
      await this.prisma.$transaction(async (tx) => {
        await tx.pricingVersion.update({ where: { id: versionId }, data: { status: "SCHEDULED", effectiveFrom: at } });
        await this.audit.record(
          { ...ctx, actorId: actor.user.id },
          "pricing.version_scheduled",
          { type: "pricing_version", id: versionId },
          { after: { productId: version.productId, versionNo: version.versionNo, effectiveFrom: at } },
          tx,
        );
      }, TX);
      return this.listVersions(version.productId);
    }
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const current = await tx.pricingVersion.findFirst({
        where: { productId: version.productId, status: "PUBLISHED" },
      });
      // Archive first: a partial unique index allows only one published version per product.
      if (current)
        await tx.pricingVersion.update({
          where: { id: current.id },
          data: { status: "ARCHIVED", effectiveTo: now },
        });
      await tx.pricingVersion.update({
        where: { id: versionId },
        data: { status: "PUBLISHED", publishedAt: now, effectiveFrom: now },
      });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "pricing.version_published",
        { type: "pricing_version", id: versionId },
        {
          before: current ? { versionId: current.id, versionNo: current.versionNo } : undefined,
          after: { productId: version.productId, versionNo: version.versionNo },
        },
        tx,
      );
    }, TX);
    return this.listVersions(version.productId);
  }

  /** A scheduled version goes back to being a draft. */
  async unschedule(actor: StaffContext, versionId: string, ctx: AuditContext) {
    const version = await this.prisma.pricingVersion.findUnique({ where: { id: versionId } });
    if (!version) throw notFound("Pricing version");
    if (version.status !== "SCHEDULED")
      throw new ProblemException(409, "NOT_SCHEDULED", "This version isn't scheduled");
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pricingVersion.updateMany({
        where: { id: versionId, status: "SCHEDULED" },
        data: { status: "DRAFT", effectiveFrom: new Date() },
      });
      if (!claimed.count) throw new ProblemException(409, "NOT_SCHEDULED", "This version has just gone live");
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "pricing.schedule_cancelled",
        { type: "pricing_version", id: versionId },
        { before: { effectiveFrom: version.effectiveFrom } },
        tx,
      );
    }, TX);
    return this.getVersion(versionId);
  }
}

function pick<T extends object>(row: T, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, (row as Record<string, unknown>)[k]]));
}

/** Decimals → strings so the audit JSON is stable. */
function plain(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      v instanceof Decimal || (v && typeof v === "object" && "toFixed" in v) ? String(v) : v,
    ]),
  );
}

type DiffProduct = {
  unitMany: string;
  optionGroups: { key: string; label: string; shortLabel: string | null; options: { key: string; label: string }[] }[];
};

const COMPONENT_LABEL = { perUnit: "per unit", unitPrice: "unit price", perOrder: "per order" } as const;

export function diffDocuments(before: PricingDocument, after: PricingDocument, product: DiffProduct): DiffRow[] {
  const rows: DiffRow[] = [];
  const tierQtys = [...new Set([...before.tiers, ...after.tiers].map((t) => t.minQty))].sort((a, b) => a - b);
  for (const qty of tierQtys) {
    const b = money2(before.tiers.find((t) => t.minQty === qty)?.unitPrice);
    const a = money2(after.tiers.find((t) => t.minQty === qty)?.unitPrice);
    rows.push({
      component: `tier.${qty}`,
      label: `${qty.toLocaleString("en-IN")} ${product.unitMany}: unit price`,
      before: b,
      after: a,
      change: change(b, a),
    });
  }
  const groupKeys = [...new Set([...Object.keys(before.options), ...Object.keys(after.options)])];
  for (const groupKey of groupKeys) {
    const group = product.optionGroups.find((g) => g.key === groupKey);
    const optionKeys = [
      ...new Set([...Object.keys(before.options[groupKey] ?? {}), ...Object.keys(after.options[groupKey] ?? {})]),
    ];
    for (const optionKey of optionKeys) {
      const option = group?.options.find((o) => o.key === optionKey);
      for (const comp of ["perUnit", "unitPrice", "perOrder"] as const) {
        const b = money2(before.options[groupKey]?.[optionKey]?.[comp]);
        const a = money2(after.options[groupKey]?.[optionKey]?.[comp]);
        if (b === null && a === null) continue;
        rows.push({
          component: `option.${groupKey}.${optionKey}.${comp}`,
          label: `${group?.shortLabel ?? group?.label ?? groupKey}: ${option?.label ?? optionKey} (${COMPONENT_LABEL[comp]})`,
          before: b,
          after: a,
          change: change(b, a),
        });
      }
    }
  }
  const labels = [...new Set([...before.setupCharges, ...after.setupCharges].map((c) => c.label))];
  for (const label of labels) {
    const b = money2(before.setupCharges.find((c) => c.label === label)?.amount);
    const a = money2(after.setupCharges.find((c) => c.label === label)?.amount);
    rows.push({ component: `setup.${label}`, label: `Setup: ${label}`, before: b, after: a, change: change(b, a) });
  }
  if (before.sizeSurcharge || after.sizeSurcharge) {
    const b = money2(before.sizeSurcharge?.perUnit);
    const a = money2(after.sizeSurcharge?.perUnit);
    rows.push({
      component: "sizeSurcharge",
      label: `Size surcharge (${(after.sizeSurcharge ?? before.sizeSurcharge)!.sizes.join(", ")}) per piece`,
      before: b,
      after: a,
      change: change(b, a),
    });
  }
  if (before.quoteFromQty !== undefined || after.quoteFromQty !== undefined) {
    const b = before.quoteFromQty?.toString() ?? null;
    const a = after.quoteFromQty?.toString() ?? null;
    rows.push({
      component: "quoteFromQty",
      label: "Bulk quotation from (quantity)",
      before: b,
      after: a,
      change: b === a ? null : a === null ? "Removed" : b === null ? "New" : "Changed",
    });
  }
  return rows;
}
