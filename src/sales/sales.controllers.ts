import {
  Body,
  Controller,
  Delete,
  Get,
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
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { z } from "zod";
import type { StaffContext } from "../auth/auth.service";
import { clientIp, userAgent } from "../auth/session";
import { RequirePermissions, RequireStepUp, Staff, StaffGuard } from "../auth/staff.guard";
import { CustomersService } from "./customers.service";
import { QuotesService } from "./quotes.service";

const ctxOf = (req: Request) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z0-9-]{1,63}$/);
const name = z.string().trim().min(2).max(80);
const mobile = z.string().trim().min(10).max(16);
const email = z.string().trim().email().max(120);
const gstin = z.string().trim().toUpperCase().length(15);
const moneyIn = z.string().regex(/^\d{1,9}(\.\d{1,4})?$/, 'Enter an amount like "275" or "3.99"');
const contact = z.object({ name, phone: mobile, email: email.nullish() }).strict();
const search = z.object({ q: z.string().trim().max(80).optional() });
const statuses = ["REQUESTED", "UNDER_REVIEW", "SENT", "CLARIFICATION", "ACCEPTED", "DECLINED"] as const;
const line = z
  .object({
    productId: uuid.optional(),
    config: z
      .object({
        selections: z.record(key, z.union([key, z.array(key).max(20)])),
        quantity: z.number().int().min(1).max(1_000_000).optional(),
        sizes: z.record(z.string().regex(/^[A-Z0-9]{1,5}$/), z.number().int().min(0).max(1_000_000)).optional(),
        colours: z.record(key, z.number().int().min(0).max(100)).optional(),
      })
      .strict()
      .optional(),
    description: z.string().trim().max(200).optional(),
    quantity: z.number().int().min(1).max(1_000_000).optional(),
    unitPrice: moneyIn.optional(),
    gstRate: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,2})?$/)
      .optional(),
  })
  .strict();

/** Storefront bulk-quote form (SF-QUO-01). Creates a request for the sales team; nothing is priced here. */
@ApiTags("quotes")
@Controller("quotes")
export class QuoteRequestsController {
  constructor(private readonly quotes: QuotesService) {}

  @Post("requests")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Request a bulk / corporate quotation" })
  request(@Body() body: unknown) {
    const input = z
      .object({
        contact: z.object({ name, phone: mobile, email }).strict(),
        companyName: z.string().trim().max(120).optional(),
        gstin: gstin.optional(),
        items: z
          .array(
            z
              .object({
                productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/),
                quantity: z.number().int().min(1).max(10_000_000),
                notes: z.string().trim().max(500).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
        needBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        notes: z.string().trim().max(2000).optional(),
      })
      .strict()
      .parse(body);
    return this.quotes.requestFromWeb(input);
  }
}

@ApiTags("admin · quotations")
@Controller("admin/quotes")
@UseGuards(StaffGuard)
export class AdminQuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  @RequirePermissions("quotes.read")
  list(@Query() query: Record<string, string>) {
    return this.quotes.list(search.extend({ status: z.enum(statuses).optional() }).parse(query));
  }

  @Get("options")
  @RequirePermissions("quotes.read")
  @ApiOperation({ summary: "Assignees, quotable products and GST rates for the editor" })
  options() {
    return this.quotes.options();
  }

  @Get("products/:id")
  @RequirePermissions("quotes.read")
  product(@Param("id") id: string) {
    return this.quotes.productOptions(uuid.parse(id));
  }

  @Post()
  @RequirePermissions("quotes.write")
  create(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        contact,
        companyName: z.string().trim().max(120).optional(),
        gstin: gstin.optional(),
        companyId: uuid.optional(),
      })
      .strict()
      .parse(body);
    return this.quotes.create(s, input, ctxOf(req));
  }

  @Get(":id")
  @RequirePermissions("quotes.read")
  one(@Param("id") id: string) {
    return this.quotes.get(uuid.parse(id));
  }

  @Patch(":id")
  @RequirePermissions("quotes.write")
  update(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        contact: contact.optional(),
        companyName: z.string().trim().max(120).nullable().optional(),
        gstin: gstin.nullable().optional(),
        companyId: uuid.nullable().optional(),
        assignedToId: uuid.nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        overrideReason: z.string().trim().max(500).nullable().optional(),
        validUntil: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
      })
      .strict()
      .parse(body);
    return this.quotes.update(s, uuid.parse(id), input, ctxOf(req));
  }

  @Put(":id/lines")
  @RequirePermissions("quotes.write")
  @ApiOperation({
    summary: "Replace the lines. A price different from the engine's needs quotes.override_price and a reason",
  })
  lines(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({ lines: z.array(line).max(50), overrideReason: z.string().trim().max(500).optional() })
      .strict()
      .parse(body);
    return this.quotes.setLines(s, uuid.parse(id), input.lines, input.overrideReason, ctxOf(req));
  }

  @Post(":id/send")
  @HttpCode(200)
  @RequirePermissions("quotes.write")
  @ApiOperation({ summary: "Record the current lines as a sent revision" })
  send(@Param("id") id: string, @Staff() s: StaffContext, @Req() req: Request) {
    return this.quotes.send(s, uuid.parse(id), ctxOf(req));
  }

  @Post(":id/move")
  @HttpCode(200)
  @RequirePermissions("quotes.write")
  move(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const { status } = z
      .object({ status: z.enum(statuses) })
      .strict()
      .parse(body);
    return this.quotes.move(s, uuid.parse(id), status, ctxOf(req));
  }
}

@ApiTags("admin · customers & companies")
@Controller("admin")
@UseGuards(StaffGuard)
export class AdminCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get("customers")
  @RequirePermissions("customers.read")
  list(@Query() query: Record<string, string>) {
    return this.customers.list(search.parse(query).q);
  }

  @Get("customers/:id")
  @RequirePermissions("customers.read")
  one(@Param("id") id: string) {
    return this.customers.customer(uuid.parse(id));
  }

  @Patch("customers/:id")
  @RequirePermissions("customers.write")
  update(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z.object({ name: name.optional(), email: email.nullable().optional() }).strict().parse(body);
    return this.customers.updateCustomer(s, uuid.parse(id), input, ctxOf(req));
  }

  @Get("companies")
  @RequirePermissions("customers.read")
  companies(@Query() query: Record<string, string>) {
    return this.customers.companies(search.parse(query).q);
  }

  @Post("companies")
  @RequirePermissions("customers.write")
  createCompany(@Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(120),
        gstin: gstin.nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .strict()
      .parse(body);
    return this.customers.createCompany(s, input, ctxOf(req));
  }

  @Get("companies/:id")
  @RequirePermissions("customers.read")
  company(@Param("id") id: string) {
    return this.customers.company(uuid.parse(id));
  }

  @Patch("companies/:id")
  @RequirePermissions("customers.write")
  updateCompany(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        gstin: gstin.nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .strict()
      .parse(body);
    return this.customers.updateCompany(s, uuid.parse(id), input, ctxOf(req));
  }

  @Put("companies/:id/credit")
  @RequirePermissions("credit_terms.approve")
  @RequireStepUp()
  @ApiOperation({ summary: "Enable or remove credit terms (audited; asks for the authenticator code)" })
  credit(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({ enabled: z.boolean(), termsDays: z.number().int().min(1).max(180).nullable() })
      .strict()
      .parse(body);
    return this.customers.setCredit(s, uuid.parse(id), input, ctxOf(req));
  }

  @Put("companies/:id/members")
  @RequirePermissions("customers.write")
  addMember(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({ phone: mobile, role: z.enum(["ADMIN", "MEMBER"]) })
      .strict()
      .parse(body);
    return this.customers.addMember(s, uuid.parse(id), input, ctxOf(req));
  }

  @Delete("companies/:id/members/:userId")
  @RequirePermissions("customers.write")
  removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Staff() s: StaffContext,
    @Req() req: Request,
  ) {
    return this.customers.removeMember(s, uuid.parse(id), uuid.parse(userId), ctxOf(req));
  }
}
