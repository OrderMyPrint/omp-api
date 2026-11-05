import { Injectable } from "@nestjs/common";
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import { ProblemException } from "../common/problem";
import { decimalString } from "../common/money";
import { PrismaService } from "../prisma/prisma.service";
import { tierTable, type EngineProduct } from "../pricing/engine";
import { parsePricingDocument, type PricingDocument } from "../pricing/pricing-document";

const productInclude = {
  category: { select: { slug: true, name: true } },
  taxProfile: { select: { gstRate: true } },
  optionGroups: { orderBy: { stepOrder: "asc" }, include: { options: { orderBy: { sort: "asc" } } } },
  artworkSlots: { orderBy: { sort: "asc" } },
  pricingVersions: { where: { status: "PUBLISHED" }, take: 1 },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** A published product with its validated pricing document. */
export type LoadedProduct = { row: ProductRow; doc: PricingDocument; pricingVersionId: string; engine: EngineProduct };

@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async categories() {
    const rows = await this.prisma.category.findMany({
      where: { isVisible: true },
      orderBy: { sort: "asc" },
      include: { _count: { select: { products: { where: { isVisible: true } } } } },
    });
    return rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      lead: row.lead,
      about: row.about,
      imageUrl: row.imageUrl,
      productCount: row._count.products,
    }));
  }

  async products(filter: { category?: string; q?: string }) {
    const q = filter.q?.trim();
    const rows = await this.prisma.product.findMany({
      where: {
        isVisible: true,
        ...(filter.category ? { category: { slug: filter.category } } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { summary: { contains: q, mode: "insensitive" } },
                { description: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { sort: "asc" },
      include: productInclude,
    });
    return rows.filter((row) => row.pricingVersions.length).map((row) => this.summary(row));
  }

  async product(slug: string) {
    const { row, doc, pricingVersionId } = await this.load(slug);
    return {
      ...this.summary(row),
      lead: row.lead,
      description: row.description,
      specs: row.specs,
      quantity:
        row.quantityMode === "SIZES"
          ? {
              mode: "sizes",
              sizes: row.sizes,
              defaults: row.defaultSizes,
              minimum: doc.tiers[0].minQty,
              quoteFrom: doc.quoteFromQty ?? null,
            }
          : { mode: "tiers", minimum: doc.tiers[0].minQty, quoteFrom: doc.quoteFromQty ?? null },
      optionGroups: row.optionGroups.map((group) => ({
        key: group.key,
        label: group.label,
        shortLabel: group.shortLabel,
        hint: group.hint,
        note: group.note,
        kind: group.kind,
        required: group.required,
        defaults: group.defaultKeys,
        options: group.options.map((option) => ({
          key: option.key,
          label: option.label,
          detail: option.detail,
          swatch: option.swatch,
          available: option.isAvailable,
          unavailableReason: option.unavailableReason,
          price: doc.options[group.key]?.[option.key] ?? null,
        })),
      })),
      setupCharges: doc.setupCharges,
      sizeSurcharge: doc.sizeSurcharge ?? null,
      artworkSlots: row.artworkSlots.map((slot) => ({
        key: slot.key,
        label: slot.label,
        printArea: slot.printArea,
        bleedMm: decimalString(slot.bleedMm, 1),
        safeMm: decimalString(slot.safeMm, 1),
        acceptedTypes: slot.acceptedTypes,
        maxMb: slot.maxMb,
      })),
      tiers: tierTable(doc),
      pricingVersionId,
    };
  }

  /** Loads a visible product with its published pricing, ready for the engine. */
  async load(slug: string): Promise<LoadedProduct> {
    const row = await this.prisma.product.findFirst({ where: { slug, isVisible: true }, include: productInclude });
    const version = row?.pricingVersions[0];
    if (!row || !version)
      throw new ProblemException(404, "PRODUCT_NOT_FOUND", "Product not found", `No product "${slug}".`);
    const doc = parsePricingDocument(version.document);
    return {
      row,
      doc,
      pricingVersionId: version.id,
      engine: {
        slug: row.slug,
        unitOne: row.unitOne,
        unitMany: row.unitMany,
        quantityMode: row.quantityMode,
        sizes: row.sizes,
        gstRate: row.taxProfile.gstRate.toFixed(2),
        groups: row.optionGroups.map((group) => ({
          key: group.key,
          label: group.label,
          shortLabel: group.shortLabel,
          kind: group.kind,
          required: group.required,
          options: group.options.map((option) => ({
            key: option.key,
            label: option.label,
            isAvailable: option.isAvailable,
            unavailableReason: option.unavailableReason,
          })),
        })),
      },
    };
  }

  private summary(row: ProductRow) {
    const doc = parsePricingDocument(row.pricingVersions[0].document);
    const first = doc.tiers[0];
    return {
      slug: row.slug,
      name: row.name,
      category: row.category,
      summary: row.summary,
      imageUrl: row.imageUrl,
      unit: { one: row.unitOne, many: row.unitMany },
      turnaroundDays: { min: row.turnaroundMinDays, max: row.turnaroundMaxDays },
      gstRate: row.taxProfile.gstRate.toFixed(2),
      uses: row.uses,
      materials: row.materials,
      minimumQuantity: first.minQty,
      /** Cheapest order: the first tier, before options and GST. */
      startingPrice: new Decimal(first.unitPrice)
        .times(first.minQty)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2),
      startingUnitPrice: new Decimal(first.unitPrice).toFixed(2),
    };
  }
}
