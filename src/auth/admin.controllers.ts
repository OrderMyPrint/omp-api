import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AuthService, type StaffContext } from "./auth.service";
import { AllowPendingMfa, RequirePermissions, RequireStepUp, Staff, StaffGuard } from "./staff.guard";
import { StaffService } from "./staff.service";
import { clearSessionCookies, clientIp, setSessionCookies, userAgent } from "./session";

const ctxOf = (req: Request) => ({ ip: clientIp(req), userAgent: userAgent(req) });
const uuid = z.string().uuid();
const email = z.string().trim().email().max(254);
const code = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") }).strict();

function me(staff: StaffContext) {
  return {
    id: staff.user.id,
    email: staff.user.email,
    name: staff.user.name,
    role: staff.user.role ? { id: staff.user.role.id, key: staff.user.role.key, name: staff.user.role.name } : null,
    permissions: [...staff.permissions].sort(),
    twoFactor: Boolean(staff.user.totpEnabledAt),
    secondFactorPending: !staff.session.mfaVerifiedAt,
    stepUpAt: staff.session.stepUpAt,
    csrfToken: staff.session.csrfToken,
  };
}

@ApiTags("admin · auth")
@Controller("admin/auth")
export class AdminAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Step 1: email + password → pending session; next is 'totp' or 'enroll'" })
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = z
      .object({ email, password: z.string().min(1).max(128) })
      .strict()
      .parse(body);
    const { session, ...rest } = await this.auth.login(input.email, input.password, ctxOf(req));
    setSessionCookies(res, session.token, session.csrf, session.maxAgeMs);
    return { ...rest, csrfToken: session.csrf };
  }

  @Post("invitations/accept")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Accept an invitation: set password, then enrol an authenticator" })
  async accept(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = z
      .object({ token: z.string().min(20).max(200), password: z.string().min(1).max(128) })
      .strict()
      .parse(body);
    const { session, ...rest } = await this.auth.acceptInvitation(input.token, input.password, ctxOf(req));
    setSessionCookies(res, session.token, session.csrf, session.maxAgeMs);
    return { ...rest, csrfToken: session.csrf };
  }

  @Post("totp")
  @HttpCode(200)
  @UseGuards(StaffGuard)
  @AllowPendingMfa()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Step 2: authenticator code → full session (also completes enrolment)" })
  async totp(
    @Body() body: unknown,
    @Staff() staff: StaffContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { code: value } = code.parse(body);
    const session = await this.auth.verifySecondFactor(staff, value, ctxOf(req));
    setSessionCookies(res, session.token, session.csrf, session.maxAgeMs);
    return { signedIn: true, csrfToken: session.csrf };
  }

  @Post("step-up")
  @HttpCode(200)
  @UseGuards(StaffGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Re-confirm with a fresh authenticator code before a sensitive change" })
  stepUp(@Body() body: unknown, @Staff() staff: StaffContext, @Req() req: Request) {
    return this.auth.stepUp(staff, code.parse(body).code, ctxOf(req));
  }

  @Get("me")
  @UseGuards(StaffGuard)
  @AllowPendingMfa()
  @ApiOperation({ summary: "The signed-in staff member, role and permissions" })
  me(@Staff() staff: StaffContext) {
    return me(staff);
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(StaffGuard)
  @AllowPendingMfa()
  async logout(@Staff() staff: StaffContext, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(staff, ctxOf(req));
    clearSessionCookies(res);
    return { signedOut: true };
  }
}

@ApiTags("admin · staff")
@Controller("admin")
@UseGuards(StaffGuard)
export class AdminStaffController {
  constructor(private readonly staff: StaffService) {}

  @Get("permissions")
  @RequirePermissions("staff.read")
  @ApiOperation({ summary: "Permission catalogue grouped by module" })
  permissions() {
    return this.staff.permissionCatalogue();
  }

  @Get("staff")
  @RequirePermissions("staff.read")
  list() {
    return this.staff.list();
  }

  @Get("staff/:id")
  @RequirePermissions("staff.read")
  get(@Param("id") id: string) {
    return this.staff.get(uuid.parse(id));
  }

  @Post("staff/invitations")
  @RequirePermissions("staff.manage")
  @RequireStepUp()
  @ApiOperation({ summary: "Invite a staff member; returns a one-time link to share (no email provider yet)" })
  invite(@Body() body: unknown, @Staff() actor: StaffContext, @Req() req: Request) {
    const input = z
      .object({ email, name: z.string().trim().min(2).max(100), roleId: uuid })
      .strict()
      .parse(body);
    return this.staff.invite(actor, input, ctxOf(req));
  }

  @Patch("staff/:id")
  @RequirePermissions("staff.manage")
  @RequireStepUp()
  update(@Param("id") id: string, @Body() body: unknown, @Staff() actor: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(100).optional(),
        roleId: uuid.optional(),
        status: z.enum(["ACTIVE", "DEACTIVATED"]).optional(),
      })
      .strict()
      .parse(body);
    return this.staff.update(actor, uuid.parse(id), input, ctxOf(req));
  }

  @Post("staff/:id/reset-2fa")
  @HttpCode(200)
  @RequirePermissions("staff.manage")
  @RequireStepUp()
  reset2fa(@Param("id") id: string, @Staff() actor: StaffContext, @Req() req: Request) {
    return this.staff.resetTwoFactor(actor, uuid.parse(id), ctxOf(req));
  }

  @Post("staff/:id/revoke-sessions")
  @HttpCode(200)
  @RequirePermissions("staff.manage")
  @RequireStepUp()
  revoke(@Param("id") id: string, @Staff() actor: StaffContext, @Req() req: Request) {
    return this.staff.revokeSessions(actor, uuid.parse(id), ctxOf(req));
  }

  @Get("roles")
  @RequirePermissions("staff.read")
  roles() {
    return this.staff.roles();
  }

  @Post("roles")
  @RequirePermissions("roles.manage")
  @RequireStepUp()
  createRole(@Body() body: unknown, @Staff() actor: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(60),
        description: z.string().max(300).optional(),
        permissions: z.array(z.string().max(60)).max(100),
      })
      .strict()
      .parse(body);
    return this.staff.createRole(actor, input, ctxOf(req));
  }

  @Patch("roles/:id")
  @RequirePermissions("roles.manage")
  @RequireStepUp()
  updateRole(@Param("id") id: string, @Body() body: unknown, @Staff() actor: StaffContext, @Req() req: Request) {
    const input = z
      .object({
        name: z.string().trim().min(2).max(60).optional(),
        description: z.string().max(300).optional(),
        permissions: z.array(z.string().max(60)).max(100).optional(),
      })
      .strict()
      .parse(body);
    return this.staff.updateRole(actor, uuid.parse(id), input, ctxOf(req));
  }

  @Delete("roles/:id")
  @RequirePermissions("roles.manage")
  @RequireStepUp()
  deleteRole(@Param("id") id: string, @Staff() actor: StaffContext, @Req() req: Request) {
    return this.staff.deleteRole(actor, uuid.parse(id), ctxOf(req));
  }

  @Get("audit")
  @RequirePermissions("audit.read")
  @ApiOperation({ summary: "Audit log, newest first (cursor = ISO time of the last item)" })
  audit(@Query() query: Record<string, string>) {
    const input = z
      .object({
        targetType: z.string().max(40).optional(),
        targetId: z.string().max(80).optional(),
        actorId: uuid.optional(),
        cursor: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(query);
    return this.staff.auditLog(input);
  }
}
