import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { StaffContext } from "../auth/auth.service";
import { clientIp, userAgent } from "../auth/session";
import { RequirePermissions, RequireStepUp, Staff, StaffGuard } from "../auth/staff.guard";
import { previewSchema } from "../pricing/pricing.controller";
import { CatalogueAdminService, requirePublish } from "./catalogue-admin.service";
import { CatalogueStructureService } from "./catalogue-structure.service";

const ctxOf = (req: Request) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const longText = (max: number) => z.string().trim().max(max);
const decimal1 = z
  .string()
  .regex(/^\d{1,3}(\.\d)?$/, "Use millimetres with up to one decimal, e.g. 3 or 2.5")
  .nullable();

const categoryCreate = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slugs are lower-case words joined by dashes")
      .max(60),
    name: text(80),
    summary: text(160),
    lead: longText(400).optional(),
    about: longText(2000).optional(),
  })
  .strict();
const categoryPatch = z
  .object({
    name: text(80),
    summary: text(160),
    lead: longText(400),
    about: longText(2000),
    isVisible: z.boolean(),
  })
  .partial()
  .strict();
const productPatch = z
  .object({
    name: text(80),
    summary: text(200),
    lead: longText(400),
    description: longText(4000),
    categoryId: uuid,
    unitOne: text(30),
    unitMany: text(30),
    turnaroundMinDays: z.number().int().min(1).max(60),
    turnaroundMaxDays: z.number().int().min(1).max(60),
    uploadTiming: z.enum(["BEFORE_CART", "AFTER_CHECKOUT", "EITHER"]),
    imageUrl: z
      .string()
      .regex(/^(\/[A-Za-z0-9._\-/]+|https:\/\/[^\s]+)$/, "Use a site image path like /images/x.png or an https URL")
      .max(500),
    isVisible: z.boolean(),
  })
  .partial()
  .strict();
const optionPatch = z
  .object({
    label: text(80),
    detail: longText(200).nullable(),
    isAvailable: z.boolean(),
    unavailableReason: longText(120).nullable(),
  })
  .partial()
  .strict();
const slotPatch = z
  .object({
    label: text(60),
    printArea: text(120),
    bleedMm: decimal1,
    safeMm: decimal1,
    acceptedTypes: z
      .array(z.enum(["pdf", "png", "jpg", "jpeg", "svg", "cdr", "ai", "eps", "psd", "tif", "tiff"]))
      .min(1)
      .max(11),
    maxMb: z.number().int().min(1).max(200),
  })
  .partial()
  .strict();
const draftBody = z.object({ document: z.unknown(), note: longText(300).nullable().optional() }).strict();
const testBody = previewSchema.omit({ productSlug: true });
const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slugs are lower-case words joined by dashes")
  .max(60);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Keys are lower-case letters, digits and dashes");
const newProduct = z
  .object({
    slug: slugSchema,
    name: text(80),
    categoryId: uuid,
    summary: text(200),
    unitOne: text(30),
    unitMany: text(30),
    quantityMode: z.enum(["TIERS", "SIZES"]),
    sizes: z
      .array(z.string().regex(/^[A-Z0-9]{1,5}$/, "Sizes like S, M, XL, 2XL"))
      .max(12)
      .optional(),
    taxProfileId: uuid,
    turnaroundMinDays: z.number().int().min(1).max(60),
    turnaroundMaxDays: z.number().int().min(1).max(60),
  })
  .strict();
const newGroup = z
  .object({
    key,
    label: text(80),
    shortLabel: longText(40).nullable().optional(),
    hint: longText(200),
    kind: z.enum(["SELECT", "SWATCH", "MULTISELECT"]),
    required: z.boolean(),
  })
  .strict();
const groupPatch = z
  .object({
    label: text(80),
    shortLabel: longText(40).nullable(),
    hint: longText(200),
    note: longText(300).nullable(),
    required: z.boolean(),
    defaultKeys: z.array(key).max(30),
  })
  .partial()
  .strict();
const newOption = z
  .object({
    key,
    label: text(80),
    detail: longText(200).nullable().optional(),
    swatch: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1a2b3c")
      .nullable()
      .optional(),
  })
  .strict();
const ruleBody = z
  .object({
    whenGroup: key,
    whenOption: key,
    effect: z.enum(["EXCLUDES", "REQUIRES"]),
    thenGroup: key,
    thenOptions: z.array(key).min(1).max(30),
    message: text(200),
  })
  .strict();
const newSlot = z
  .object({ label: text(60), printArea: text(120), bleedMm: decimal1.optional(), safeMm: decimal1.optional() })
  .strict();
const ids = z.object({ ids: z.array(uuid).min(1).max(200) }).strict();
const publishBody = z.object({ effectiveFrom: z.coerce.date().optional() }).strict();

/** AD-CAT-01…03 and AD-PRC-01…03 · Catalogue and pricing administration. */
@ApiTags("admin · catalogue & pricing")
@Controller("admin/catalogue")
@UseGuards(StaffGuard)
export class CatalogueAdminController {
  constructor(
    private readonly catalogue: CatalogueAdminService,
    private readonly structure: CatalogueStructureService,
  ) {}

  // Categories
  @Get("categories")
  @RequirePermissions("catalogue.read")
  @ApiOperation({ summary: "All categories, including hidden ones, with product counts" })
  categories() {
    return this.catalogue.listCategories();
  }

  @Post("categories")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Create a category (hidden until shown)" })
  createCategory(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.createCategory(s, categoryCreate.parse(body), ctxOf(req));
  }

  @Put("categories/order")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Set the menu order (every category id, in order)" })
  reorder(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const { ids } = z
      .object({ ids: z.array(uuid).min(1).max(200) })
      .strict()
      .parse(body);
    return this.catalogue.reorderCategories(s, ids, ctxOf(req));
  }

  @Patch("categories/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Edit a category; showing or hiding it also needs catalogue.publish" })
  updateCategory(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.updateCategory(s, uuid.parse(id), categoryPatch.parse(body), ctxOf(req));
  }

  @Delete("categories/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Delete an empty category" })
  deleteCategory(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.deleteCategory(s, uuid.parse(id), ctxOf(req));
  }

  // Products
  @Get("products")
  @RequirePermissions("catalogue.read")
  @ApiOperation({ summary: "All products, including hidden ones, with pricing status" })
  products() {
    return this.catalogue.listProducts();
  }

  @Get("products/:id")
  @RequirePermissions("catalogue.read")
  product(@Param("id") id: string) {
    return this.catalogue.getProduct(uuid.parse(id));
  }

  @Patch("products/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Edit product details; showing or hiding it also needs catalogue.publish" })
  updateProduct(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.updateProduct(s, uuid.parse(id), productPatch.parse(body), ctxOf(req));
  }

  @Patch("options/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Edit an option's label, detail and availability" })
  updateOption(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.updateOption(s, uuid.parse(id), optionPatch.parse(body), ctxOf(req));
  }

  @Patch("artwork-slots/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Edit an artwork slot (print area, bleed, safe zone, file rules)" })
  updateSlot(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.updateArtworkSlot(s, uuid.parse(id), slotPatch.parse(body), ctxOf(req));
  }

  // Pricing
  @Get("products/:id/pricing")
  @RequirePermissions("pricing.read")
  @ApiOperation({ summary: "Pricing versions for a product, newest first" })
  versions(@Param("id") id: string) {
    return this.catalogue.listVersions(uuid.parse(id));
  }

  @Post("products/:id/pricing/drafts")
  @RequirePermissions("pricing.write")
  @ApiOperation({ summary: "Start a draft from the published version (one draft per product)" })
  createDraft(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.createDraft(s, uuid.parse(id), ctxOf(req));
  }

  @Get("pricing/:versionId")
  @RequirePermissions("pricing.read")
  version(@Param("versionId") id: string) {
    return this.catalogue.getVersion(uuid.parse(id));
  }

  @Put("pricing/:versionId")
  @RequirePermissions("pricing.write")
  @ApiOperation({ summary: "Save a draft's pricing document (validated against the product)" })
  saveDraft(@Param("versionId") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.saveDraft(s, uuid.parse(id), draftBody.parse(body), ctxOf(req));
  }

  @Delete("pricing/:versionId")
  @RequirePermissions("pricing.write")
  @ApiOperation({ summary: "Discard a draft" })
  discard(@Param("versionId") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.discardDraft(s, uuid.parse(id), ctxOf(req));
  }

  @Get("pricing/:versionId/diff")
  @RequirePermissions("pricing.read")
  @ApiOperation({ summary: "Compare a version with the published one" })
  diff(@Param("versionId") id: string) {
    return this.catalogue.diff(uuid.parse(id));
  }

  @Post("pricing/:versionId/test")
  @HttpCode(200)
  @RequirePermissions("pricing.read")
  @ApiOperation({ summary: "Test bench: price a configuration with this version (draft or published)" })
  test(@Param("versionId") id: string, @Body() body: unknown) {
    return this.catalogue.test(uuid.parse(id), testBody.parse(body));
  }

  @Post("pricing/:versionId/publish")
  @HttpCode(200)
  @RequirePermissions("pricing.publish")
  @RequireStepUp()
  @ApiOperation({ summary: "Publish a draft now; the previous version is archived" })
  publish(@Param("versionId") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.publish(s, uuid.parse(id), publishBody.parse(body ?? {}), ctxOf(req));
  }

  @Post("pricing/:versionId/unschedule")
  @HttpCode(200)
  @RequirePermissions("pricing.publish")
  @ApiOperation({ summary: "Cancel a scheduled version (it becomes a draft again)" })
  unschedule(@Param("versionId") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.catalogue.unschedule(s, uuid.parse(id), ctxOf(req));
  }

  // New products, slugs, option groups, rules and artwork slots (AD-CAT-03/04/05)
  @Get("tax-profiles")
  @RequirePermissions("catalogue.read")
  taxProfiles() {
    return this.structure.taxProfiles();
  }

  @Post("products")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Create a product (hidden until it has an image, an artwork slot and published pricing)" })
  createProduct(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.createProduct(s, newProduct.parse(body), ctxOf(req));
  }

  @Put("products/:id/slug")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Change a product's URL; adds a redirect and updates website content" })
  productSlug(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    requirePublish(s, "catalogue.publish", "Changing a live address");
    const { slug } = z.object({ slug: slugSchema }).strict().parse(body);
    return this.structure.changeProductSlug(s, uuid.parse(id), slug, ctxOf(req));
  }

  @Put("categories/:id/slug")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Change a category's URL; adds a redirect and updates website content" })
  categorySlug(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    requirePublish(s, "catalogue.publish", "Changing a live address");
    const { slug } = z.object({ slug: slugSchema }).strict().parse(body);
    return this.structure.changeCategorySlug(s, uuid.parse(id), slug, ctxOf(req));
  }

  @Post("products/:id/option-groups")
  @RequirePermissions("catalogue.write")
  addGroup(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.addGroup(s, uuid.parse(id), newGroup.parse(body), ctxOf(req));
  }

  @Put("products/:id/option-groups/order")
  @RequirePermissions("catalogue.write")
  reorderGroups(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.reorderGroups(s, uuid.parse(id), ids.parse(body).ids, ctxOf(req));
  }

  @Patch("option-groups/:id")
  @RequirePermissions("catalogue.write")
  updateGroup(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.updateGroup(s, uuid.parse(id), groupPatch.parse(body), ctxOf(req));
  }

  @Delete("option-groups/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Delete an option group no pricing version or rule uses" })
  deleteGroup(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.deleteGroup(s, uuid.parse(id), ctxOf(req));
  }

  @Post("option-groups/:id/options")
  @RequirePermissions("catalogue.write")
  addOption(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.addOption(s, uuid.parse(id), newOption.parse(body), ctxOf(req));
  }

  @Put("option-groups/:id/options/order")
  @RequirePermissions("catalogue.write")
  reorderOptions(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.reorderOptions(s, uuid.parse(id), ids.parse(body).ids, ctxOf(req));
  }

  @Delete("options/:id")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Delete an option no pricing version or rule uses" })
  deleteOption(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.deleteOption(s, uuid.parse(id), ctxOf(req));
  }

  @Post("products/:id/rules")
  @RequirePermissions("catalogue.write")
  @ApiOperation({ summary: "Add a constraint rule (enforced by the pricing engine)" })
  addRule(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.addRule(s, uuid.parse(id), ruleBody.parse(body), ctxOf(req));
  }

  @Put("rules/:id")
  @RequirePermissions("catalogue.write")
  updateRule(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.updateRule(s, uuid.parse(id), ruleBody.parse(body), ctxOf(req));
  }

  @Delete("rules/:id")
  @RequirePermissions("catalogue.write")
  deleteRule(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.deleteRule(s, uuid.parse(id), ctxOf(req));
  }

  @Post("products/:id/artwork-slots")
  @RequirePermissions("catalogue.write")
  addSlot(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.addSlot(s, uuid.parse(id), newSlot.parse(body), ctxOf(req));
  }

  @Delete("artwork-slots/:id")
  @RequirePermissions("catalogue.write")
  deleteSlot(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.structure.deleteSlot(s, uuid.parse(id), ctxOf(req));
  }
}
