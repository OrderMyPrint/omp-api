import { z } from "zod";

/**
 * Versioned pricing document (docs repo: docs/prd/product-catalogue-and-pricing.md §4).
 * It is data, interpreted by the engine — never evaluated as code. Every money
 * value is a decimal string so no precision is lost on the way in or out.
 */

const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,4})?$/, 'Money must be a decimal string with up to 4 decimals, e.g. "1.80"');

const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Keys are lower-case letters, digits and dashes");

export const optionPriceSchema = z
  .object({
    /** Added per unit on top of the base unit price. */
    perUnit: money.optional(),
    /** Replaces the tier unit price (e.g. a different DTF sheet size). */
    unitPrice: money.optional(),
    /** Added once per order line. */
    perOrder: money.optional(),
  })
  .strict();

export const pricingDocumentSchema = z
  .object({
    currency: z.literal("INR"),
    /** Where the figures come from, e.g. "Researched reference rates (D-08)". */
    source: z.string().min(1).max(200),
    /** Quantity tiers, ascending by minQty. The first tier is the minimum order. */
    tiers: z
      .array(z.object({ minQty: z.number().int().positive(), unitPrice: money }).strict())
      .min(1)
      .refine((tiers) => tiers.every((tier, i) => i === 0 || tier.minQty > tiers[i - 1].minQty), {
        message: "Tiers must be in ascending minQty order without duplicates",
      }),
    /** Quantities at or above this are priced by the sales team (bulk quotation). */
    quoteFromQty: z.number().int().positive().optional(),
    /** Option prices: groupKey → optionKey → price components. Unlisted options cost nothing extra. */
    options: z.record(key, z.record(key, optionPriceSchema)).default({}),
    /** One-off setup charges, e.g. one screen per colour per print location. */
    setupCharges: z
      .array(
        z
          .object({
            kind: z.literal("perColourPerSelection"),
            label: z.string().min(1).max(60),
            /** Multiselect group whose selected options each carry a colour count. */
            group: key,
            appliesWhen: z.object({ group: key, option: key }).strict(),
            amount: money,
            maxColours: z.number().int().min(1).max(12),
          })
          .strict(),
      )
      .default([]),
    /** Extra per piece for some sizes (size-breakdown products). */
    sizeSurcharge: z
      .object({ sizes: z.array(z.string().min(1)).min(1), perUnit: money, label: z.string().min(1).max(60) })
      .strict()
      .optional(),
  })
  .strict();

export type PricingDocument = z.infer<typeof pricingDocumentSchema>;

export function parsePricingDocument(value: unknown): PricingDocument {
  return pricingDocumentSchema.parse(value);
}
