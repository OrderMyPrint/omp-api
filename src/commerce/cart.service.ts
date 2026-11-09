import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import type { Request, Response } from "express";
import { randomToken, sha256 } from "../auth/crypto";
import { readCookie } from "../auth/session";
import { CatalogueService, type LoadedProduct } from "../catalogue/catalogue.service";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { priceConfiguration, type Configuration, type PriceResult } from "../pricing/engine";
import type { CustomerContext } from "./customer-auth";

export const CART_COOKIE = "omp_cart";
const CART_TTL_MS = 60 * 24 * 3600_000;

export type PriceSnapshot = Pick<
  PriceResult,
  "quantity" | "unitPrice" | "lines" | "subtotal" | "gstRate" | "gst" | "total"
>;

const snapshotOf = (r: PriceResult): PriceSnapshot => ({
  quantity: r.quantity,
  unitPrice: r.unitPrice,
  lines: r.lines,
  subtotal: r.subtotal,
  gstRate: r.gstRate,
  gst: r.gst,
  total: r.total,
});

/** Human-readable record of what was configured, kept with the order (labels as they were). */
export function specOf(product: LoadedProduct, config: Configuration) {
  return {
    product: { slug: product.row.slug, name: product.row.name, category: product.row.category.name },
    options: product.engine.groups
      .filter((g) => config.selections[g.key] !== undefined)
      .map((g) => {
        const keys = ([] as string[]).concat(config.selections[g.key] ?? []);
        return {
          group: g.key,
          label: g.shortLabel ?? g.label,
          choices: keys.map((k) => ({ key: k, label: g.options.find((o) => o.key === k)?.label ?? k })),
        };
      }),
    quantity: config.quantity ?? null,
    sizes: config.sizes ?? null,
    colours: config.colours ?? null,
    unit: { one: product.row.unitOne, many: product.row.unitMany },
  };
}

export type PricedLine = {
  item: { id: string; configuration: Configuration; priceSnapshot: PriceSnapshot; pricingVersionId: string };
  product: LoadedProduct | null;
  result: PriceResult | null;
  problem: string | null;
};

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: CatalogueService,
  ) {}

  /** Prices a configuration with the product's live pricing; refuses invalid or bulk-quote configurations. */
  async price(productSlug: string, config: Configuration) {
    const product = await this.catalogue.load(productSlug);
    const result = priceConfiguration(product.engine, product.doc, config);
    if (!result.valid)
      throw new ProblemException(422, "CONFIG_INVALID", "This configuration can't be ordered", undefined, {
        errors: result.errors,
      });
    if (result.requiresQuote)
      throw new ProblemException(409, "BULK_QUOTE", "This quantity needs a bulk quotation", "Request a quote instead.");
    return { product, result };
  }

  /** The visitor's cart: the signed-in customer's, or the guest cart from the cookie. */
  async find(req: Request, customer: CustomerContext | null) {
    if (customer) return this.prisma.cart.findUnique({ where: { userId: customer.user.id } });
    const token = readCookie(req, CART_COOKIE);
    return token ? this.prisma.cart.findUnique({ where: { tokenHash: sha256(token) } }) : null;
  }

  async findOrCreate(req: Request, res: Response, customer: CustomerContext | null) {
    const existing = await this.find(req, customer);
    if (existing) return existing;
    if (customer) return this.prisma.cart.create({ data: { userId: customer.user.id } });
    const token = randomToken();
    res.cookie(CART_COOKIE, token, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: (process.env.COOKIE_SECURE ?? "true") !== "false",
      maxAge: CART_TTL_MS,
    });
    return this.prisma.cart.create({ data: { tokenHash: sha256(token) } });
  }

  /** On sign-in the guest cart's items move into the customer's cart. */
  async mergeGuestCart(req: Request, res: Response, userId: string) {
    const token = readCookie(req, CART_COOKIE);
    if (!token) return;
    const guest = await this.prisma.cart.findUnique({ where: { tokenHash: sha256(token) } });
    res.clearCookie(CART_COOKIE, { path: "/" });
    if (!guest) return;
    const mine = await this.prisma.cart.upsert({ where: { userId }, update: {}, create: { userId } });
    await this.prisma.$transaction([
      this.prisma.cartItem.updateMany({ where: { cartId: guest.id }, data: { cartId: mine.id } }),
      this.prisma.cart.delete({ where: { id: guest.id } }),
    ]);
  }

  async addItem(cartId: string, productSlug: string, config: Configuration) {
    const { product, result } = await this.price(productSlug, config);
    const count = await this.prisma.cartItem.count({ where: { cartId } });
    if (count >= 50) throw new ProblemException(409, "CART_FULL", "Your cart is full");
    return this.prisma.cartItem.create({
      data: {
        cartId,
        productId: product.row.id,
        configuration: config as Prisma.InputJsonValue,
        priceSnapshot: snapshotOf(result) as Prisma.InputJsonValue,
        pricingVersionId: product.pricingVersionId,
      },
    });
  }

  async updateItem(cartId: string, itemId: string, patch: Pick<Configuration, "quantity" | "sizes">) {
    const item = await this.prisma.cartItem.findFirst({ where: { id: itemId, cartId }, include: { product: true } });
    if (!item) throw new ProblemException(404, "NOT_FOUND", "Cart item not found");
    const config = { ...(item.configuration as Configuration), ...patch };
    const { product, result } = await this.price(item.product.slug, config);
    return this.prisma.cartItem.update({
      where: { id: itemId },
      data: {
        configuration: config as Prisma.InputJsonValue,
        priceSnapshot: snapshotOf(result) as Prisma.InputJsonValue,
        pricingVersionId: product.pricingVersionId,
      },
    });
  }

  async removeItem(cartId: string, itemId: string) {
    const removed = await this.prisma.cartItem.deleteMany({ where: { id: itemId, cartId } });
    if (!removed.count) throw new ProblemException(404, "NOT_FOUND", "Cart item not found");
  }

  /** Re-prices every line with the live pricing; lines that can no longer be ordered carry a problem. */
  async priceLines(cartId: string): Promise<PricedLine[]> {
    const items = await this.prisma.cartItem.findMany({
      where: { cartId },
      orderBy: { createdAt: "asc" },
      include: { product: { select: { slug: true } } },
    });
    const lines: PricedLine[] = [];
    for (const item of items) {
      const base = {
        id: item.id,
        configuration: item.configuration as Configuration,
        priceSnapshot: item.priceSnapshot as PriceSnapshot,
        pricingVersionId: item.pricingVersionId,
      };
      try {
        const product = await this.catalogue.load(item.product.slug);
        const result = priceConfiguration(product.engine, product.doc, base.configuration);
        const problem = !result.valid
          ? result.errors.map((e) => e.message).join(" ")
          : result.requiresQuote
            ? "This quantity now needs a bulk quotation."
            : null;
        lines.push({ item: base, product, result, problem });
      } catch {
        lines.push({ item: base, product: null, result: null, problem: "This product is no longer available." });
      }
    }
    return lines;
  }

  view(lines: PricedLine[]) {
    let subtotal = new Decimal(0);
    let gst = new Decimal(0);
    for (const l of lines)
      if (!l.problem && l.result) {
        subtotal = subtotal.plus(l.result.subtotal!);
        gst = gst.plus(l.result.gst!);
      }
    return {
      items: lines.map((l) => ({
        id: l.item.id,
        product: l.product
          ? { slug: l.product.row.slug, name: l.product.row.name, imageUrl: l.product.row.imageUrl }
          : null,
        configuration: l.item.configuration,
        spec: l.product ? specOf(l.product, l.item.configuration) : null,
        price: l.result && !l.problem ? snapshotOf(l.result) : null,
        /** True when the live price differs from the price when the item was added (§4.4). */
        priceChanged: !!l.result && !l.problem && l.result.total !== l.item.priceSnapshot.total,
        previousTotal: l.item.priceSnapshot.total,
        problem: l.problem,
      })),
      subtotal: subtotal.toFixed(2),
      gst: gst.toFixed(2),
      /** Shipping charges aren't configured yet (D-06b): null, and totals exclude shipping. */
      shipping: null,
      total: subtotal.plus(gst).toFixed(2),
      canCheckout: lines.length > 0 && lines.every((l) => !l.problem),
    };
  }
}
