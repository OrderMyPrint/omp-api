import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { CatalogueService } from "../catalogue/catalogue.service";
import { priceConfiguration } from "./engine";

const key = z.string().regex(/^[a-z0-9-]{1,63}$/);
const count = z.number().int().min(0).max(1_000_000);

export const previewSchema = z
  .object({
    productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/),
    selections: z.record(key, z.union([key, z.array(key).max(20)])),
    quantity: count.optional(),
    sizes: z.record(z.string().regex(/^[A-Z0-9]{1,5}$/), count).optional(),
    colours: z.record(key, z.number().int().min(0).max(100)).optional(),
  })
  .strict();

@ApiTags("pricing")
@Controller("pricing")
export class PricingController {
  constructor(private readonly catalogue: CatalogueService) {}

  /**
   * Prices a configuration with the product's published pricing version.
   * Invalid configurations return 200 with `valid: false` and field errors, so
   * the configurator can show them inline.
   */
  @Post("preview")
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: "Price a product configuration (server-authoritative)" })
  async preview(@Body() body: unknown) {
    const input = previewSchema.parse(body);
    const product = await this.catalogue.load(input.productSlug);
    const result = priceConfiguration(product.engine, product.doc, input);
    return {
      productSlug: product.row.slug,
      pricingVersionId: product.pricingVersionId,
      turnaroundDays: { min: product.row.turnaroundMinDays, max: product.row.turnaroundMaxDays },
      ...result,
    };
  }
}
