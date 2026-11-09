import { describe, expect, it } from "vitest";
import { products } from "../../prisma/reference/catalogue";
import { pricingDocumentFor } from "../../prisma/seed-helpers";
import { groupIndian, priceConfiguration, tierFor, type Configuration, type EngineProduct } from "./engine";
import { parsePricingDocument } from "./pricing-document";

/** Builds the engine view of a reference product, as the catalogue service does from the database. */
function fixture(slug: string) {
  const product = products.find((item) => item.slug === slug)!;
  const engine: EngineProduct = {
    slug,
    unitOne: product.unitNoun.one,
    unitMany: product.unitNoun.many,
    quantityMode: product.quantity.kind === "sizes" ? "SIZES" : "TIERS",
    sizes: product.quantity.kind === "sizes" ? product.quantity.sizes : [],
    gstRate: (product.gstRate * 100).toFixed(2),
    groups: product.steps.map((step) => ({
      key: step.id,
      label: step.title,
      shortLabel: step.short ?? null,
      kind: step.kind === "multi" ? "MULTISELECT" : step.kind === "swatch" ? "SWATCH" : "SELECT",
      required: true,
      options: step.choices.map((choice) => ({
        key: choice.id,
        label: choice.label,
        isAvailable: !choice.unavailable,
        unavailableReason: choice.unavailable ?? null,
      })),
    })),
  };
  const defaults: Configuration = {
    selections: Object.fromEntries(
      product.steps.map((step) => [step.id, step.kind === "multi" ? step.defaultIds : step.defaultId]),
    ),
    quantity: [...product.tiers].sort((a, b) => a.quantity - b.quantity)[Math.min(2, product.tiers.length - 1)]
      .quantity,
    sizes: product.quantity.kind === "sizes" ? { ...product.quantity.defaults } : undefined,
  };
  return { engine, doc: pricingDocumentFor(product), defaults };
}

describe("pricing engine", () => {
  it("matches the approved Figma reference for visiting cards (₹1,652.00)", () => {
    const { engine, doc, defaults } = fixture("visiting-cards");
    const result = priceConfiguration(engine, doc, defaults);
    expect(result.valid).toBe(true);
    expect(result.lines.map((line) => [line.label, line.amount])).toEqual([
      ["500 cards × ₹1.80", "900.00"],
      ["Paper: Premium Matte 350 GSM", "120.00"],
      ["Printing: Double-sided", "180.00"],
      ["Finish: Soft-touch", "200.00"],
    ]);
    expect([result.subtotal, result.gst, result.total]).toEqual(["1400.00", "252.00", "1652.00"]);
  });

  it("prices T-shirts by size with screens, 2XL surcharge and 5% GST", () => {
    const { engine, doc, defaults } = fixture("corporate-t-shirts");
    const result = priceConfiguration(engine, doc, defaults);
    expect(result.quantity).toBe(80);
    expect(result.lines.map((line) => line.amount)).toEqual(["23920.00", "300.00", "150.00"]);
    expect([result.subtotal, result.gst, result.total]).toEqual(["24370.00", "1218.50", "25588.50"]);
  });

  it("counts one screen per colour per location and drops screens for DTF", () => {
    const { engine, doc, defaults } = fixture("corporate-t-shirts");
    const screen = priceConfiguration(engine, doc, {
      ...defaults,
      selections: { ...defaults.selections, locations: ["front", "back"] },
      colours: { front: 2, back: 1 },
    });
    expect(screen.lines.find((line) => line.code === "SETUP:locations")?.amount).toBe("900.00");
    expect(screen.lines.find((line) => line.code === "OPTION:locations:back")?.amount).toBe("3200.00");
    const dtf = priceConfiguration(engine, doc, { ...defaults, selections: { ...defaults.selections, method: "dtf" } });
    expect(dtf.lines.some((line) => line.code.startsWith("SETUP"))).toBe(false);
  });

  it("switches to a bulk quotation at the threshold", () => {
    const { engine, doc, defaults } = fixture("corporate-t-shirts");
    const result = priceConfiguration(engine, doc, { ...defaults, sizes: { M: 300 } });
    expect(result).toMatchObject({ valid: true, requiresQuote: true, total: null });
  });

  it("lets a sheet size replace the tier price", () => {
    const { engine, doc, defaults } = fixture("dtf-stickers");
    const result = priceConfiguration(engine, doc, {
      ...defaults,
      selections: { ...defaults.selections, sheet: "22x24" },
      quantity: 2,
    });
    expect(result.subtotal).toBe("498.00");
  });

  it("rejects unknown, unavailable and missing options with field errors", () => {
    const { engine, doc, defaults } = fixture("corporate-t-shirts");
    const result = priceConfiguration(engine, doc, {
      ...defaults,
      selections: { ...defaults.selections, garment: "polo", fabric: "silk", extra: "x", colour: undefined as never },
    });
    expect(result.valid).toBe(false);
    expect(result.total).toBeNull();
    expect(result.errors.map((error) => error.code).sort()).toEqual([
      "OPTION_UNAVAILABLE",
      "REQUIRED",
      "UNKNOWN_GROUP",
      "UNKNOWN_OPTION",
    ]);
  });

  it("enforces constraint rules (excludes and requires)", () => {
    const { engine, doc, defaults } = fixture("visiting-cards");
    const rules: EngineProduct["rules"] = [
      {
        whenGroup: "finish",
        whenOption: "soft-touch",
        effect: "REQUIRES",
        thenGroup: "paper",
        thenOptions: ["premium-matte-350", "kraft-350"],
        message: "Soft-touch needs a 350 GSM paper.",
      },
      {
        whenGroup: "corners",
        whenOption: "rounded",
        effect: "EXCLUDES",
        thenGroup: "size",
        thenOptions: ["square"],
        message: "Rounded corners aren't available on square cards.",
      },
    ];
    const withRules = { ...engine, rules };
    const config = (selections: Record<string, string>) => ({
      ...defaults,
      selections: { ...defaults.selections, ...selections },
    });
    const blocked = priceConfiguration(
      withRules,
      doc,
      config({ finish: "soft-touch", paper: "classic-matte-300", corners: "rounded", size: "square" }),
    );
    expect(blocked.valid).toBe(false);
    expect(blocked.errors).toEqual([
      { code: "CONSTRAINT_VIOLATION", field: "selections.paper", message: "Soft-touch needs a 350 GSM paper." },
      {
        code: "CONSTRAINT_VIOLATION",
        field: "selections.size",
        message: "Rounded corners aren't available on square cards.",
      },
    ]);
    const allowed = priceConfiguration(
      withRules,
      doc,
      config({ finish: "soft-touch", paper: "kraft-350", corners: "rounded", size: "standard" }),
    );
    expect(allowed.valid).toBe(true);
  });

  it("enforces the minimum quantity and whole numbers", () => {
    const { engine, doc, defaults } = fixture("visiting-cards");
    expect(priceConfiguration(engine, doc, { ...defaults, quantity: 50 }).errors[0].code).toBe(
      "QUANTITY_BELOW_MINIMUM",
    );
    expect(priceConfiguration(engine, doc, { ...defaults, quantity: 2.5 }).errors[0].code).toBe("QUANTITY_INVALID");
  });

  it("rounds HALF-UP to paise", () => {
    const { engine, doc, defaults } = fixture("visiting-cards");
    // 333 × ₹2.60 = 865.80; +0.24 × 333 = 79.92; +0.36 × 333 = 119.88; +0.40 × 333 = 133.20
    const result = priceConfiguration(engine, doc, { ...defaults, quantity: 333 });
    expect(result.subtotal).toBe("1198.80");
    expect(result.gst).toBe("215.78"); // 215.784 → 215.78
  });

  it("gives every reference product a valid default configuration", () => {
    for (const product of products) {
      const { engine, doc, defaults } = fixture(product.slug);
      const result = priceConfiguration(engine, doc, defaults);
      expect(result.valid, `${product.slug}: ${JSON.stringify(result.errors)}`).toBe(true);
      expect(Number(result.total), product.slug).toBeGreaterThan(0);
    }
  });

  it("groups quantities the Indian way in labels", () => {
    expect([groupIndian(500), groupIndian(1000), groupIndian(250000), groupIndian(12345678)]).toEqual([
      "500",
      "1,000",
      "2,50,000",
      "1,23,45,678",
    ]);
  });

  it("picks the highest tier at or below the quantity", () => {
    const { doc } = fixture("visiting-cards");
    expect(tierFor(doc, 499).unitPrice).toBe("2.6");
    expect(tierFor(doc, 2500).unitPrice).toBe("1.3");
  });
});

describe("pricing document", () => {
  it("rejects floats, unknown fields and unordered tiers", () => {
    const base = { currency: "INR", source: "test", tiers: [{ minQty: 10, unitPrice: "1.00" }] };
    expect(() => parsePricingDocument({ ...base, tiers: [{ minQty: 10, unitPrice: 1 }] })).toThrow();
    expect(() => parsePricingDocument({ ...base, formula: "1+1" })).toThrow();
    expect(() =>
      parsePricingDocument({
        ...base,
        tiers: [
          { minQty: 10, unitPrice: "1" },
          { minQty: 5, unitPrice: "1" },
        ],
      }),
    ).toThrow();
    expect(parsePricingDocument(base).options).toEqual({});
  });
});
