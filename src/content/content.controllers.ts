import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { StaffContext } from "../auth/auth.service";
import { clientIp, userAgent } from "../auth/session";
import { RequirePermissions, Staff, StaffGuard } from "../auth/staff.guard";
import { ProblemException } from "../common/problem";
import { ContentService } from "./content.service";

const ctxOf = (req: Request) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const uuid = z.string().uuid();
const path = z
  .string()
  .regex(/^\/[a-z0-9/-]*$/, "Paths are lower-case, start with / and use letters, digits, - and /")
  .max(200);
const CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/** Published content for the storefront. Drafts are never served here. */
@ApiTags("content")
@Controller("content")
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Get("pages")
  @Header("Cache-Control", CACHE)
  @ApiOperation({ summary: "A published page by path, with sections resolved (products, categories, FAQ, images)" })
  page(@Query("path") value: string) {
    return this.content.publishedPage(path.parse(value ?? ""));
  }

  @Get("navigation")
  @Header("Cache-Control", CACHE)
  navigation() {
    return this.content.publishedNavigation();
  }

  @Get("site-settings")
  @Header("Cache-Control", CACHE)
  @ApiOperation({ summary: "Brand, contact, active announcement, SEO defaults and redirects" })
  settings() {
    return this.content.publishedSiteSettings();
  }

  @Get("faq")
  @Header("Cache-Control", CACHE)
  faq() {
    return this.content.publishedFaq();
  }
}

@ApiTags("admin · website content")
@Controller("admin/content")
@UseGuards(StaffGuard)
export class AdminContentController {
  constructor(private readonly content: ContentService) {}

  // Pages
  @Get("pages")
  @RequirePermissions("content.read")
  pages() {
    return this.content.listPages();
  }

  @Post("pages")
  @RequirePermissions("content.write")
  createPage(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        key: z.string().regex(/^[a-z0-9-]{2,60}$/),
        path,
        title: z.string().trim().min(1).max(120),
        type: z.enum(["CONTENT", "LANDING", "POLICY"]),
      })
      .strict()
      .parse(body);
    return this.content.createPage(s, input, ctxOf(req));
  }

  @Get("pages/:id")
  @RequirePermissions("content.read")
  page(@Param("id") id: string) {
    return this.content.getPage(uuid.parse(id));
  }

  @Put("pages/:id/draft")
  @RequirePermissions("content.write")
  @ApiOperation({ summary: "Save the page draft (the whole document)" })
  saveDraft(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.saveDraft(
      s,
      uuid.parse(id),
      z.object({ document: z.unknown() }).strict().parse(body).document,
      ctxOf(req),
    );
  }

  @Get("pages/:id/preview")
  @RequirePermissions("content.read")
  preview(@Param("id") id: string) {
    return this.content.previewDraft(uuid.parse(id));
  }

  @Post("pages/:id/publish")
  @HttpCode(200)
  @RequirePermissions("content.publish")
  publish(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.publishPage(s, uuid.parse(id), ctxOf(req));
  }

  @Post("pages/:id/versions/:versionId/restore")
  @HttpCode(200)
  @RequirePermissions("content.write")
  @ApiOperation({ summary: "Copy an earlier version into the draft (publish to make it live)" })
  restore(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Staff() s: StaffContext,
    @Req() req: Request,
  ) {
    return this.content.restoreVersion(s, uuid.parse(id), uuid.parse(versionId), ctxOf(req));
  }

  // Navigation
  @Get("navigation")
  @RequirePermissions("content.read")
  menus() {
    return this.content.menus();
  }

  @Put("navigation/:key")
  @RequirePermissions("navigation.write")
  saveMenu(@Param("key") key: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.saveMenu(s, key, z.object({ draft: z.unknown() }).strict().parse(body).draft, ctxOf(req));
  }

  @Post("navigation/publish")
  @HttpCode(200)
  @RequirePermissions("navigation.write", "content.publish")
  publishMenus(@Staff() s: StaffContext, @Req() req: Request) {
    return this.content.publishMenus(s, ctxOf(req));
  }

  // Site settings
  @Get("site-settings")
  @RequirePermissions("content.read")
  settings() {
    return this.content.settings();
  }

  @Put("site-settings")
  @RequirePermissions("site_settings.write")
  saveSettings(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.saveSettings(s, z.object({ draft: z.unknown() }).strict().parse(body).draft, ctxOf(req));
  }

  @Post("site-settings/publish")
  @HttpCode(200)
  @RequirePermissions("site_settings.write", "content.publish")
  publishSettings(@Staff() s: StaffContext, @Req() req: Request) {
    return this.content.publishSettings(s, ctxOf(req));
  }

  // FAQ
  @Get("faq")
  @RequirePermissions("content.read")
  faq() {
    return this.content.faqAdmin();
  }

  @Post("faq/topics")
  @RequirePermissions("content.write")
  createTopic(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        key: z.string().regex(/^[a-z0-9-]{2,60}$/),
        title: z.string().trim().min(1).max(80),
        sort: z.number().int().min(0).max(1000).optional(),
      })
      .strict()
      .parse(body);
    return this.content.createFaqTopic(s, input, ctxOf(req));
  }

  private faqFields = {
    topicId: uuid,
    question: z.string().trim().min(5).max(200),
    answer: z.string().trim().min(5).max(2000),
    sort: z.number().int().min(0).max(1000),
    showOnHomepage: z.boolean(),
    isPublished: z.boolean(),
  };

  /** Publishing or unpublishing a question needs content.publish, not just content.write. */
  private guardPublish(s: StaffContext, input: { isPublished?: boolean; showOnHomepage?: boolean }) {
    if (
      (input.isPublished !== undefined || input.showOnHomepage !== undefined) &&
      !s.permissions.has("content.publish")
    )
      throw new ProblemException(
        403,
        "FORBIDDEN",
        "You can edit questions but not publish them",
        "Your role doesn’t include content.publish.",
        { missing: ["content.publish"] },
      );
  }

  @Post("faq/items")
  @RequirePermissions("content.write")
  createItem(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const f = this.faqFields;
    const input = z
      .object({
        topicId: f.topicId,
        question: f.question,
        answer: f.answer,
        sort: f.sort.optional(),
        showOnHomepage: f.showOnHomepage.optional(),
        isPublished: f.isPublished.optional(),
      })
      .strict()
      .parse(body);
    this.guardPublish(s, input);
    return this.content.createFaqItem(s, input, ctxOf(req));
  }

  @Patch("faq/items/:id")
  @RequirePermissions("content.write")
  updateItem(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z.object(this.faqFields).partial().strict().parse(body);
    this.guardPublish(s, input);
    return this.content.updateFaqItem(s, uuid.parse(id), input, ctxOf(req));
  }

  @Delete("faq/items/:id")
  @RequirePermissions("content.write", "content.publish")
  deleteItem(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.deleteFaqItem(s, uuid.parse(id), ctxOf(req));
  }

  // Media
  @Get("media")
  @RequirePermissions("content.read")
  media() {
    return this.content.media();
  }

  @Post("media")
  @RequirePermissions("media.write")
  @ApiOperation({
    summary:
      "Register an image already shipped with the storefront (/images/…). Uploads arrive with object storage (D-05).",
  })
  registerMedia(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        url: z
          .string()
          .regex(/^\/images\/[a-z0-9-]+\.(png|jpe?g|webp|svg)$/, "Use a storefront image path like /images/hero.png"),
        fileName: z.string().trim().min(1).max(120),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
        width: z.number().int().positive().max(20000).optional(),
        height: z.number().int().positive().max(20000).optional(),
        alt: z.string().trim().max(300),
      })
      .strict()
      .parse(body);
    return this.content.registerMedia(s, input, ctxOf(req));
  }

  @Patch("media/:id")
  @RequirePermissions("media.write")
  updateMedia(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.updateMedia(
      s,
      uuid.parse(id),
      z
        .object({ alt: z.string().trim().max(300) })
        .strict()
        .parse(body),
      ctxOf(req),
    );
  }

  @Delete("media/:id")
  @RequirePermissions("media.write")
  deleteMedia(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.deleteMedia(s, uuid.parse(id), ctxOf(req));
  }

  // Redirects
  @Get("redirects")
  @RequirePermissions("content.read")
  redirects() {
    return this.content.redirects();
  }

  @Post("redirects")
  @RequirePermissions("site_settings.write")
  createRedirect(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({ fromPath: path, toPath: path, permanent: z.boolean().default(true) })
      .strict()
      .parse(body);
    return this.content.createRedirect(s, input, ctxOf(req));
  }

  @Delete("redirects/:id")
  @RequirePermissions("site_settings.write")
  deleteRedirect(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.content.deleteRedirect(s, uuid.parse(id), ctxOf(req));
  }
}
