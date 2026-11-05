import Decimal from "decimal.js";
import type { PricingDocument } from "./pricing-document";

/**
 * Pricing engine — pure functions, no I/O. The server is authoritative
 * (ADR-0002): clients send a configuration and receive a price.
 *
 * Rounding (docs/prd/product-catalogue-and-pricing.md §4.2): intermediate maths
 * in decimal.js, each price line rounded to ₹0.01 HALF-UP, GST computed on the
 * line subtotal and rounded HALF-UP. The CA must confirm GST rounding (D-28).
 */

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const money = (value: Decimal.Value) => new D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fmt = (value: Decimal) => value.toFixed(2);

/** Indian digit grouping for quantities in labels: 1,000 · 1,00,000. */
export function groupIndian(value: number): string {
  const digits = String(Math.trunc(value));
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return rest ? `${rest},${last}` : last;
}

/** The parts of the product schema the engine needs (loaded from the catalogue). */
export type EngineProduct = {
  slug: string;
  unitOne: string;
  unitMany: string;
  quantityMode: "TIERS" | "SIZES";
  sizes: string[];
  gstRate: string;
  groups: {
    key: string;
    label: string;
    shortLabel: string | null;
    kind: "SELECT" | "SWATCH" | "MULTISELECT";
    required: boolean;
    options: { key: string; label: string; isAvailable: boolean; unavailableReason: string | null }[];
  }[];
};

export type Configuration = {
  selections: Record<string, string | string[]>;
  quantity?: number;
  sizes?: Record<string, number>;
  colours?: Record<string, number>;
};

export type ConfigError = { code: string; field: string; message: string };

export type PriceLine = { code: string; label: string; amount: string };

export type TierRow = { minQty: number; unitPrice: string; total: string; savingPercent: number };

export type PriceResult = {
  valid: boolean;
  errors: ConfigError[];
  requiresQuote: boolean;
  quantity: number;
  unitPrice: string | null;
  lines: PriceLine[];
  subtotal: string | null;
  gstRate: string;
  gst: string | null;
  total: string | null;
  tiers: TierRow[];
};

/** The tier that applies to a quantity: the highest tier at or below it. */
export function tierFor(doc: PricingDocument, quantity: number) {
  return doc.tiers.reduce((match, tier) => (quantity >= tier.minQty ? tier : match), doc.tiers[0]);
}

export function tierTable(doc: PricingDocument): TierRow[] {
  const base = new D(doc.tiers[0].unitPrice);
  return doc.tiers.map((tier) => {
    const unit = new D(tier.unitPrice);
    return {
      minQty: tier.minQty,
      unitPrice: unit.toFixed(2),
      total: fmt(money(unit.times(tier.minQty))),
      savingPercent: Math.round(new D(1).minus(unit.div(base)).times(100).toNumber()),
    };
  });
}

function validate(product: EngineProduct, doc: PricingDocument, config: Configuration) {
  const errors: ConfigError[] = [];
  const groupKeys = new Set(product.groups.map((group) => group.key));

  for (const key of Object.keys(config.selections ?? {})) {
    if (!groupKeys.has(key))
      errors.push({ code: "UNKNOWN_GROUP", field: `selections.${key}`, message: `Unknown option group "${key}".` });
  }

  for (const group of product.groups) {
    const raw = config.selections?.[group.key];
    const field = `selections.${group.key}`;
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
      if (group.required) errors.push({ code: "REQUIRED", field, message: `Choose ${group.label.toLowerCase()}.` });
      continue;
    }
    const multi = group.kind === "MULTISELECT";
    if (multi !== Array.isArray(raw)) {
      errors.push({
        code: "CONFIG_INVALID",
        field,
        message: multi ? "Expected a list of options." : "Expected a single option.",
      });
      continue;
    }
    const chosen = Array.isArray(raw) ? raw : [raw];
    if (new Set(chosen).size !== chosen.length)
      errors.push({ code: "CONFIG_INVALID", field, message: "An option is listed twice." });
    for (const optionKey of chosen) {
      const option = group.options.find((item) => item.key === optionKey);
      if (!option)
        errors.push({ code: "UNKNOWN_OPTION", field, message: `"${optionKey}" is not an option for ${group.label}.` });
      else if (!option.isAvailable)
        errors.push({
          code: "OPTION_UNAVAILABLE",
          field,
          message: `${option.label} can't be ordered online${option.unavailableReason ? ` (${option.unavailableReason})` : ""}.`,
        });
    }
  }

  for (const charge of doc.setupCharges) {
    const selected = config.selections?.[charge.group];
    const list = Array.isArray(selected) ? selected : [];
    for (const [optionKey, count] of Object.entries(config.colours ?? {})) {
      if (!list.includes(optionKey)) continue;
      if (!Number.isInteger(count) || count < 1 || count > charge.maxColours)
        errors.push({
          code: "COLOURS_INVALID",
          field: `colours.${optionKey}`,
          message: `Colours must be between 1 and ${charge.maxColours}.`,
        });
    }
  }

  let quantity = 0;
  if (product.quantityMode === "SIZES") {
    const sizes = config.sizes ?? {};
    for (const [size, count] of Object.entries(sizes)) {
      if (!product.sizes.includes(size))
        errors.push({ code: "INVALID_SIZE", field: `sizes.${size}`, message: `Unknown size "${size}".` });
      else if (!Number.isInteger(count) || count < 0 || count > 100000)
        errors.push({ code: "QUANTITY_INVALID", field: `sizes.${size}`, message: "Enter a whole number of pieces." });
      else quantity += count;
    }
  } else {
    quantity = config.quantity ?? 0;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000)
      errors.push({
        code: "QUANTITY_INVALID",
        field: "quantity",
        message: "Enter a whole quantity between 1 and 1,000,000.",
      });
  }

  const minimum = doc.tiers[0].minQty;
  if (quantity < minimum && !errors.some((error) => error.code === "QUANTITY_INVALID"))
    errors.push({
      code: "QUANTITY_BELOW_MINIMUM",
      field: product.quantityMode === "SIZES" ? "sizes" : "quantity",
      message: `Minimum order is ${minimum} ${minimum === 1 ? product.unitOne : product.unitMany}.`,
    });

  return { errors, quantity };
}

export function priceConfiguration(product: EngineProduct, doc: PricingDocument, config: Configuration): PriceResult {
  const { errors, quantity } = validate(product, doc, config);
  const empty: PriceResult = {
    valid: false,
    errors,
    requiresQuote: false,
    quantity,
    unitPrice: null,
    lines: [],
    subtotal: null,
    gstRate: product.gstRate,
    gst: null,
    total: null,
    tiers: tierTable(doc),
  };
  if (errors.length) return empty;
  if (doc.quoteFromQty && quantity >= doc.quoteFromQty) return { ...empty, valid: true, requiresQuote: true };

  let unit = new D(tierFor(doc, quantity).unitPrice);
  const optionLines: PriceLine[] = [];

  for (const group of product.groups) {
    const raw = config.selections[group.key];
    if (raw === undefined) continue;
    const label = group.shortLabel ?? group.label;
    for (const optionKey of Array.isArray(raw) ? raw : [raw]) {
      const price = doc.options[group.key]?.[optionKey];
      if (!price) continue;
      const option = group.options.find((item) => item.key === optionKey)!;
      if (price.unitPrice !== undefined) unit = new D(price.unitPrice);
      if (price.perUnit !== undefined)
        optionLines.push({
          code: `OPTION:${group.key}:${optionKey}`,
          label: `${label}: ${option.label}`,
          amount: fmt(money(new D(price.perUnit).times(quantity))),
        });
      if (price.perOrder !== undefined)
        optionLines.push({
          code: `ORDER:${group.key}:${optionKey}`,
          label: `${label}: ${option.label}`,
          amount: fmt(money(price.perOrder)),
        });
    }
  }

  for (const charge of doc.setupCharges) {
    if (config.selections[charge.appliesWhen.group] !== charge.appliesWhen.option) continue;
    const selected = config.selections[charge.group];
    const count = (Array.isArray(selected) ? selected : []).reduce((sum, key) => sum + (config.colours?.[key] ?? 1), 0);
    if (count > 0)
      optionLines.push({
        code: `SETUP:${charge.group}`,
        label: `${charge.label}: ${count} × ₹${new D(charge.amount).toFixed(0)}`,
        amount: fmt(money(new D(charge.amount).times(count))),
      });
  }

  if (doc.sizeSurcharge && product.quantityMode === "SIZES") {
    const pieces = doc.sizeSurcharge.sizes.reduce((sum, size) => sum + (config.sizes?.[size] ?? 0), 0);
    if (pieces > 0)
      optionLines.push({
        code: "SIZE_SURCHARGE",
        label: `${doc.sizeSurcharge.label}: ${pieces} × ₹${new D(doc.sizeSurcharge.perUnit).toFixed(0)}`,
        amount: fmt(money(new D(doc.sizeSurcharge.perUnit).times(pieces))),
      });
  }

  const noun = quantity === 1 ? product.unitOne : product.unitMany;
  const lines: PriceLine[] = [
    {
      code: "BASE",
      label: `${groupIndian(quantity)} ${noun} × ₹${unit.toFixed(2)}`,
      amount: fmt(money(unit.times(quantity))),
    },
    ...optionLines,
  ];

  const subtotal = money(lines.reduce((sum, line) => sum.plus(line.amount), new D(0)));
  const gst = money(subtotal.times(product.gstRate).div(100));
  return {
    ...empty,
    valid: true,
    unitPrice: unit.toFixed(2),
    lines,
    subtotal: fmt(subtotal),
    gst: fmt(gst),
    total: fmt(subtotal.plus(gst)),
  };
}
