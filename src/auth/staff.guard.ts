import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ProblemException } from "../common/problem";
import { AuthService, type StaffContext } from "./auth.service";
import { safeEqual } from "./crypto";
import { CSRF_HEADER, SESSION_COOKIE, STEP_UP_TTL_MS, readCookie } from "./session";

const PERMISSIONS_KEY = "omp:permissions";
const STEP_UP_KEY = "omp:step-up";
const PENDING_KEY = "omp:allow-pending";

/** Every listed permission is required. */
export const RequirePermissions = (...keys: string[]) => SetMetadata(PERMISSIONS_KEY, keys);
/** A fresh authenticator code (POST /admin/auth/step-up) within the last 5 minutes is required. */
export const RequireStepUp = () => SetMetadata(STEP_UP_KEY, true);
/** Allows a session that has passed the password but not yet the authenticator code. */
export const AllowPendingMfa = () => SetMetadata(PENDING_KEY, true);

export const Staff = createParamDecorator((_: unknown, ctx: ExecutionContext): StaffContext => {
  return (ctx.switchToHttp().getRequest() as Request & { staff: StaffContext }).staff;
});

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Staff authentication and authorisation for /admin routes:
 * session cookie → signed in with 2FA → CSRF token on writes → permissions → step-up.
 * The admin UI only mirrors these rules; this guard is the enforcement.
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { staff?: StaffContext }>();
    const targets = [context.getHandler(), context.getClass()];
    const token = readCookie(req, SESSION_COOKIE);
    const staff = token ? await this.auth.resolve(token) : null;
    if (!staff) throw new ProblemException(401, "UNAUTHENTICATED", "Please sign in");

    const allowPending = this.reflector.getAllAndOverride<boolean>(PENDING_KEY, targets);
    if (!staff.session.mfaVerifiedAt && !allowPending)
      throw new ProblemException(401, "SECOND_FACTOR_REQUIRED", "Enter your authenticator code to finish signing in");

    if (UNSAFE.has(req.method)) {
      const header = String(req.headers[CSRF_HEADER] ?? "");
      if (!header || !safeEqual(header, staff.session.csrfToken))
        throw new ProblemException(
          403,
          "CSRF_INVALID",
          "This request couldn’t be verified",
          "Reload the page and try again.",
        );
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const missing = required.filter((key) => !staff.permissions.has(key));
    if (missing.length)
      throw new ProblemException(
        403,
        "FORBIDDEN",
        "You don’t have access to this",
        `Your role doesn’t include ${missing.join(", ")}.`,
        {
          missing,
        },
      );

    if (this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, targets)) {
      const at = staff.session.stepUpAt?.getTime() ?? 0;
      if (Date.now() - at > STEP_UP_TTL_MS)
        throw new ProblemException(
          403,
          "STEP_UP_REQUIRED",
          "Confirm it’s you",
          "Enter a fresh authenticator code to make this change.",
        );
    }

    req.staff = staff;
    return true;
  }
}
