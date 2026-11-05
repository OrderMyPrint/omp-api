import type { Product } from "./reference/catalogue";
import { parsePricingDocument, type PricingDocument } from "../src/pricing/pricing-document";

const SOURCE = "Researched market reference rates from the approved Figma design — business must confirm (D-08)";

const str = (value: number) => String(Number(value.toFixed(4)));

/** JSON with sorted keys, so documents compare equal regardless of JSONB key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function pricingDocumentFor(product: Product): PricingDocument {
  const options: PricingDocument["options"] = {};
  const setupCharges: PricingDocument["setupCharges"] = [];
  for (const step of product.steps) {
    for (const choice of step.choices) {
      const price: Record<string, string> = {};
      if (choice.perUnit) price.perUnit = str(choice.perUnit);
      if (choice.unitPrice !== undefined) price.unitPrice = str(choice.unitPrice);
      if (choice.perOrder) price.perOrder = str(choice.perOrder);
      if (Object.keys(price).length) (options[step.id] ??= {})[choice.id] = price;
    }
    if (step.kind === "multi" && step.coloursPerChoice) {
      setupCharges.push({
        kind: "perColourPerSelection",
        label: step.coloursPerChoice.label,
        group: step.id,
        appliesWhen: { group: step.coloursPerChoice.whenStep, option: step.coloursPerChoice.equals },
        amount: str(step.coloursPerChoice.perColour),
        maxColours: 6,
      });
    }
  }
  const sizes = product.quantity.kind === "sizes" ? product.quantity : undefined;
  return parsePricingDocument({
    currency: "INR",
    source: SOURCE,
    tiers: [...product.tiers]
      .sort((a, b) => a.quantity - b.quantity)
      .map((tier) => ({ minQty: tier.quantity, unitPrice: str(tier.unitPrice) })),
    ...(sizes ? { quoteFromQty: sizes.quoteFrom } : {}),
    options,
    setupCharges,
    ...(sizes
      ? {
          sizeSurcharge: {
            sizes: sizes.surchargeSizes,
            perUnit: str(sizes.surcharge),
            label: `${sizes.surchargeSizes[0]} and above`,
          },
        }
      : {}),
  });
}
