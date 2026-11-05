import { Controller, Get, Header, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CatalogueService } from "./catalogue.service";

const slug = z.string().regex(/^[a-z0-9-]{1,80}$/, "Invalid slug");
const listQuery = z.object({ category: slug.optional(), q: z.string().max(100).optional() });

/** Public catalogue. Short shared caching: content changes rarely and prices are re-checked at checkout. */
@ApiTags("catalogue")
@Controller("catalogue")
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get("categories")
  @Header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300")
  @ApiOperation({ summary: "Visible categories with product counts" })
  categories() {
    return this.catalogue.categories();
  }

  @Get("products")
  @Header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300")
  @ApiOperation({ summary: "Product listing, optionally by category or search text" })
  @ApiQuery({ name: "category", required: false })
  @ApiQuery({ name: "q", required: false })
  products(@Query() query: Record<string, string>) {
    return this.catalogue.products(listQuery.parse(query));
  }

  @Get("products/:slug")
  @Header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300")
  @ApiOperation({ summary: "Product with option schema, artwork slots and price tiers" })
  product(@Param("slug") value: string) {
    return this.catalogue.product(slug.parse(value));
  }
}
