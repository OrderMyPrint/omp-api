import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { z } from "zod";
import type { StaffContext } from "../auth/auth.service";
import { clientIp, userAgent } from "../auth/session";
import { RequirePermissions, RequireStepUp, Staff, StaffGuard } from "../auth/staff.guard";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { CartService } from "./cart.service";
import { Customer, CustomerAuthService, CustomerGuard, customerView, type CustomerContext } from "./customer-auth";
import { OrdersService } from "./orders.service";

const ctxOf = (req: Request) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const uuid = z.string().uuid();
const key = z.string().regex(/^[a-z0-9-]{1,63}$/);
const count = z.number().int().min(0).max(1_000_000);
const configuration = z
  .object({
    selections: z.record(key, z.union([key, z.array(key).max(20)])),
    quantity: count.optional(),
    sizes: z.record(z.string().regex(/^[A-Z0-9]{1,5}$/), count).optional(),
    colours: z.record(key, z.number().int().min(0).max(100)).optional(),
  })
  .strict();
const address = z
  .object({
    name: z.string().trim().min(2).max(80),
    line1: z.string().trim().min(3).max(120),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(2).max(60),
    state: z.string().trim().min(2).max(40),
    pincode: z.string().regex(/^[1-9][0-9]{5}$/, "Enter a 6-digit PIN code"),
    phone: z
      .string()
      .regex(/^[6-9][0-9]{9}$/, "Enter a 10-digit mobile number")
      .optional(),
  })
  .strict();
const checkout = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(120).optional(),
    billingAddress: address,
    shippingAddress: address.optional(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN")
      .optional(),
    companyName: z.string().trim().min(2).max(120).optional(),
    acceptTerms: z.literal(true, { message: "Please accept the terms to place the order" }),
    expectedTotal: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
  })
  .strict();
const orderNumber = z.string().regex(/^OMP-\d{4}-\d{6}$/, "Invalid order number");

// ---------------------------------------------------------------- customer sign-in (SF-CHK-01, X-09)

@ApiTags("customer auth")
@Controller("auth")
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly cart: CartService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("otp/request")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: "Send a 6-digit sign-in code by SMS (valid 10 minutes)" })
  request(@Body() body: unknown, @Req() req: Request) {
    const { phone } = z
      .object({ phone: z.string().max(20) })
      .strict()
      .parse(body);
    return this.auth.requestOtp(phone, clientIp(req));
  }

  @Post("otp/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Check the code; signs in (first sign-in creates the account) and merges the guest cart" })
  async verify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = z
      .object({ phone: z.string().max(20), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") })
      .strict()
      .parse(body);
    const done = await this.auth.verifyOtp(input.phone, input.code, ctxOf(req));
    this.auth.setCookies(res, done.token, done.csrf);
    await this.cart.mergeGuestCart(req, res, done.user.id);
    return { ...customerView(done.user), csrfToken: done.csrf, isNew: done.isNew };
  }

  @Get("me")
  @UseGuards(CustomerGuard)
  me(@Customer() c: CustomerContext) {
    return { ...customerView(c.user), csrfToken: c.session.csrfToken };
  }

  @Patch("me")
  @UseGuards(CustomerGuard)
  @ApiOperation({ summary: "First-time details: name and optional email" })
  async profile(@Body() body: unknown, @Customer() c: CustomerContext) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().trim().email().max(120).nullable().optional(),
      })
      .strict()
      .parse(body);
    const email = input.email?.toLowerCase();
    if (email && (await this.prisma.user.findFirst({ where: { email, id: { not: c.user.id } } })))
      throw new ProblemException(409, "EMAIL_IN_USE", "This email is used by another account");
    const user = await this.prisma.user.update({
      where: { id: c.user.id },
      data: { name: input.name, ...(input.email !== undefined ? { email: email ?? null } : {}) },
    });
    return customerView(user);
  }

  @Post("sign-out")
  @HttpCode(200)
  @UseGuards(CustomerGuard)
  async signOut(@Customer() c: CustomerContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.signOut(c);
    this.auth.clearCookies(res);
    return { signedOut: true };
  }
}

// ---------------------------------------------------------------- cart (SF-CART-01)

@ApiTags("cart")
@Controller("cart")
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly auth: CustomerAuthService,
  ) {}

  /** Guests use the cart cookie; signed-in customers their own cart (and the CSRF header on writes). */
  private async who(req: Request) {
    const customer = await this.auth.resolve(req);
    if (customer) this.auth.checkCsrf(req, customer);
    return customer;
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "The cart, re-priced with live pricing; changed prices are flagged" })
  async get(@Req() req: Request) {
    const cart = await this.cart.find(req, await this.who(req));
    return this.cart.view(cart ? await this.cart.priceLines(cart.id) : []);
  }

  @Post("items")
  @ApiOperation({ summary: "Add a configured product (priced on the server)" })
  async add(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = z
      .object({ productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/) })
      .merge(configuration)
      .strict()
      .parse(body);
    const { productSlug, ...config } = input;
    const cart = await this.cart.findOrCreate(req, res, await this.who(req));
    await this.cart.addItem(cart.id, productSlug, config);
    return this.cart.view(await this.cart.priceLines(cart.id));
  }

  @Patch("items/:id")
  @ApiOperation({ summary: "Change the quantity (or sizes) of a line" })
  async update(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    const patch = z.object({ quantity: count.optional(), sizes: configuration.shape.sizes }).strict().parse(body);
    const cart = await this.cart.find(req, await this.who(req));
    if (!cart) throw new ProblemException(404, "NOT_FOUND", "Cart item not found");
    await this.cart.updateItem(cart.id, uuid.parse(id), patch);
    return this.cart.view(await this.cart.priceLines(cart.id));
  }

  @Delete("items/:id")
  async remove(@Param("id") id: string, @Req() req: Request) {
    const cart = await this.cart.find(req, await this.who(req));
    if (!cart) throw new ProblemException(404, "NOT_FOUND", "Cart item not found");
    await this.cart.removeItem(cart.id, uuid.parse(id));
    return this.cart.view(await this.cart.priceLines(cart.id));
  }
}

// ---------------------------------------------------------------- checkout & account (SF-CHK, SF-ACC)

@ApiTags("checkout")
@Controller()
@UseGuards(CustomerGuard)
export class CheckoutController {
  constructor(
    private readonly orders: OrdersService,
    private readonly cart: CartService,
  ) {}

  @Post("checkout/orders")
  @ApiOperation({
    summary: "Place an order from the cart (Idempotency-Key header; 409 PRICE_CHANGED if the total moved)",
  })
  async place(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() req: Request,
    @Customer() c: CustomerContext,
  ) {
    const key = z
      .string({ message: "Send an Idempotency-Key header" })
      .regex(/^[A-Za-z0-9_-]{8,64}$/, "Idempotency-Key must be 8–64 letters, digits, - or _")
      .parse(idempotencyKey);
    const input = checkout.parse(body);
    const cart = await this.cart.find(req, c);
    return this.orders.placeOrder(c, cart?.id ?? null, key, input);
  }

  @Post("checkout/orders/:number/pay")
  @HttpCode(200)
  @ApiOperation({ summary: "Start a payment with the gateway; the order turns paid only on a verified webhook" })
  pay(@Param("number") number: string, @Customer() c: CustomerContext) {
    return this.orders.startPayment(c, orderNumber.parse(number));
  }

  @Get("account/orders")
  @Header("Cache-Control", "no-store")
  list(@Customer() c: CustomerContext) {
    return this.orders.customerOrders(c);
  }

  @Get("account/orders/:number")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "One order (also polled by the payment return page)" })
  one(@Param("number") number: string, @Customer() c: CustomerContext) {
    return this.orders.customerOrder(c, orderNumber.parse(number));
  }
}

// ---------------------------------------------------------------- payment gateway

@ApiTags("payments")
@Controller("payments")
export class PaymentsController {
  constructor(private readonly orders: OrdersService) {}

  @Post("webhooks/:provider")
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiOperation({ summary: "Gateway webhook: signature-verified, de-duplicated by event id" })
  webhook(@Param("provider") provider: string, @Headers() headers: Record<string, string>, @Body() body: unknown) {
    return this.orders.handleWebhook(
      z
        .string()
        .regex(/^[a-z0-9-]{1,30}$/)
        .parse(provider),
      headers,
      body,
    );
  }

  /**
   * Development stand-in for the gateway's hosted page: completes a test payment by sending the
   * same signed webhook a gateway would. Exists only while the test provider is enabled.
   */
  @Post("test/complete")
  @HttpCode(200)
  async completeTest(@Body() body: unknown) {
    const test = this.orders.testProvider();
    if (!test) throw new ProblemException(404, "NOT_FOUND", "Not found");
    const input = z
      .object({
        providerRef: z.string().max(80),
        outcome: z.enum(["captured", "failed"]),
        amount: z.string().regex(/^\d{1,10}\.\d{2}$/),
        eventId: z.string().max(80).optional(),
      })
      .strict()
      .parse(body);
    const signed = test.event(
      input.outcome === "captured" ? "payment.captured" : "payment.failed",
      input.providerRef,
      input.amount,
      input.eventId,
    );
    return this.orders.handleWebhook("test", signed.headers, signed.body);
  }
}

// ---------------------------------------------------------------- admin (AD-ORD-01/02/02b/02c)

const listQuery = z.object({
  status: z
    .enum([
      "AWAITING_PAYMENT",
      "PAID",
      "IN_PRODUCTION",
      "READY_TO_DISPATCH",
      "DISPATCHED",
      "DELIVERED",
      "CANCELLED",
      "ON_HOLD",
    ])
    .optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});

@ApiTags("admin · orders")
@Controller("admin/orders")
@UseGuards(StaffGuard)
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions("orders.read")
  list(@Query() query: Record<string, string>) {
    return this.orders.adminList(listQuery.parse(query));
  }

  @Get("export.csv")
  @RequirePermissions("orders.read")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="orders.csv"')
  export(@Query() query: Record<string, string>) {
    const { status, q } = listQuery.parse(query);
    return this.orders.exportCsv({ status, q });
  }

  @Get(":id")
  @RequirePermissions("orders.read")
  one(@Param("id") id: string) {
    return this.orders.adminOrder(uuid.parse(id));
  }

  @Post(":id/hold")
  @HttpCode(200)
  @RequirePermissions("orders.write")
  @ApiOperation({ summary: "Put on hold: production and dispatch pause until released" })
  hold(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        reason: z.string().trim().min(3).max(120),
        reviewOn: z.coerce.date().optional(),
        note: z.string().trim().max(1000).optional(),
      })
      .strict()
      .parse(body);
    return this.orders.hold(s, uuid.parse(id), input, ctxOf(req));
  }

  @Post(":id/release")
  @HttpCode(200)
  @RequirePermissions("orders.write")
  release(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const { note } = z
      .object({ note: z.string().trim().max(1000).optional() })
      .strict()
      .parse(body ?? {});
    return this.orders.release(s, uuid.parse(id), note, ctxOf(req));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermissions("orders.cancel")
  @RequireStepUp()
  @ApiOperation({ summary: "Cancel the order or some items; requests a refund when it was paid" })
  cancel(@Param("id") id: string, @Body() body: unknown, @Staff() s: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        reason: z.string().trim().min(3).max(120),
        note: z.string().trim().max(1000).optional(),
        itemIds: z.array(uuid).min(1).max(50).optional(),
      })
      .strict()
      .parse(body);
    return this.orders.cancel(s, uuid.parse(id), input, ctxOf(req));
  }
}
