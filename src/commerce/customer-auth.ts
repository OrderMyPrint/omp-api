import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
  createParamDecorator,
} from "@nestjs/common";
import { randomInt } from "node:crypto";
import type { Request, Response } from "express";
import type { User, CustomerSession } from "@prisma/client";
import { randomToken, safeEqual, sha256 } from "../auth/crypto";
import { CSRF_HEADER, readCookie } from "../auth/session";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { SMS_SENDER, type SmsSender } from "../providers/providers";

export const CUSTOMER_COOKIE = "omp_customer_session";
export const CUSTOMER_CSRF_COOKIE = "omp_customer_csrf";
const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_RESEND_MS = 30_000;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_LOCK_MS = 15 * 60_000;
const OTP_MAX_PER_HOUR = 5;

export type CustomerContext = { session: CustomerSession; user: User };

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const secure = () => (process.env.COOKIE_SECURE ?? "true") !== "false";
const cookieBase = () => {
  const domain = process.env.COOKIE_DOMAIN?.trim();
  return { path: "/", sameSite: "lax" as const, secure: secure(), ...(domain ? { domain } : {}) };
};

/** Indian mobile numbers only (+91 fixed, X-09): "98765 43210", "+91 98765 43210" → "+919876543210". */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, "").replace(/^\+?91(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

const codeHash = (challengeId: string, code: string) => sha256(`${challengeId}:${code}`);

@Injectable()
export class CustomerAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SMS_SENDER) private readonly sms: SmsSender | null,
  ) {}

  private notOpen() {
    return new ProblemException(
      503,
      "SIGN_IN_NOT_OPEN",
      "Sign-in isn't open yet",
      "Customer sign-in opens once an SMS provider is set up.",
    );
  }

  private async lockedUntil(phone: string) {
    const locked = await this.prisma.otpChallenge.findFirst({
      where: { phoneE164: phone, lockedUntil: { gt: new Date() } },
      orderBy: { lockedUntil: "desc" },
    });
    return locked?.lockedUntil ?? null;
  }

  async requestOtp(phoneInput: string, ip: string | null) {
    if (!this.sms) throw this.notOpen();
    const phone = normalisePhone(phoneInput);
    if (!phone) throw new ProblemException(400, "PHONE_INVALID", "Enter a 10-digit Indian mobile number");
    const locked = await this.lockedUntil(phone);
    if (locked)
      throw new ProblemException(429, "OTP_LOCKED", "Too many wrong codes", "Try again after 15 minutes.", {
        retryAt: locked,
      });
    const recent = await this.prisma.otpChallenge.findMany({
      where: { phoneE164: phone, createdAt: { gt: new Date(Date.now() - 3600_000) } },
      orderBy: { createdAt: "desc" },
    });
    const last = recent[0];
    if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_MS)
      throw new ProblemException(429, "OTP_RESEND_WAIT", "Please wait before asking for a new code", undefined, {
        retryAfterSec: Math.ceil((OTP_RESEND_MS - (Date.now() - last.createdAt.getTime())) / 1000),
      });
    if (recent.length >= OTP_MAX_PER_HOUR)
      throw new ProblemException(429, "OTP_TOO_MANY", "Too many codes requested", "Try again in an hour.");

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challenge = await this.prisma.otpChallenge.create({
      data: { phoneE164: phone, codeHash: "pending", expiresAt: new Date(Date.now() + OTP_TTL_MS), ip },
    });
    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { codeHash: codeHash(challenge.id, code) },
    });
    // Older unused codes stop working once a new one is sent.
    await this.prisma.otpChallenge.updateMany({
      where: { phoneE164: phone, id: { not: challenge.id }, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    try {
      await this.sms.sendOtp(phone, code);
    } catch {
      throw new ProblemException(502, "SMS_FAILED", "We couldn't send the code", "Please try again in a moment.");
    }
    return {
      phone: `${phone.slice(0, 3)} ${phone.slice(3, 8)} ${phone.slice(8)}`,
      expiresInSec: OTP_TTL_MS / 1000,
      resendAfterSec: OTP_RESEND_MS / 1000,
    };
  }

  /** Checks the code; on success signs in (creating the customer on first sign-in) and returns a session. */
  async verifyOtp(phoneInput: string, code: string, meta: { ip: string | null; userAgent: string | null }) {
    if (!this.sms) throw this.notOpen();
    const phone = normalisePhone(phoneInput);
    if (!phone) throw new ProblemException(400, "PHONE_INVALID", "Enter a 10-digit Indian mobile number");
    if (await this.lockedUntil(phone))
      throw new ProblemException(429, "OTP_LOCKED", "Too many wrong codes", "Try again after 15 minutes.");
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phoneE164: phone, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge || challenge.expiresAt < new Date())
      throw new ProblemException(400, "OTP_EXPIRED", "This code has expired", "Ask for a new code.");
    if (!safeEqual(challenge.codeHash, codeHash(challenge.id, code))) {
      const attempts = challenge.attempts + 1;
      const lock = attempts >= OTP_MAX_ATTEMPTS;
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          attempts,
          ...(lock ? { lockedUntil: new Date(Date.now() + OTP_LOCK_MS), consumedAt: new Date() } : {}),
        },
      });
      if (lock) throw new ProblemException(429, "OTP_LOCKED", "Too many wrong codes", "Try again after 15 minutes.");
      throw new ProblemException(400, "OTP_INVALID", "That code isn't right", undefined, {
        attemptsLeft: OTP_MAX_ATTEMPTS - attempts,
      });
    }
    const claimed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!claimed.count) throw new ProblemException(400, "OTP_EXPIRED", "This code has already been used");

    const existing = await this.prisma.user.findUnique({ where: { phoneE164: phone } });
    if (existing && existing.kind !== "CUSTOMER")
      throw new ProblemException(409, "PHONE_IN_USE", "This number belongs to a staff account");
    const user =
      existing ?? (await this.prisma.user.create({ data: { kind: "CUSTOMER", phoneE164: phone, name: "" } }));
    const token = randomToken();
    const csrf = randomToken(24);
    const session = await this.prisma.customerSession.create({
      data: {
        tokenHash: sha256(token),
        userId: user.id,
        csrfToken: csrf,
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return { user, session, token, csrf, isNew: !existing };
  }

  setCookies(res: Response, token: string, csrf: string) {
    res.cookie(CUSTOMER_COOKIE, token, { ...cookieBase(), httpOnly: true, maxAge: SESSION_TTL_MS });
    res.cookie(CUSTOMER_CSRF_COOKIE, csrf, { ...cookieBase(), httpOnly: false, maxAge: SESSION_TTL_MS });
  }

  clearCookies(res: Response) {
    res.clearCookie(CUSTOMER_COOKIE, cookieBase());
    res.clearCookie(CUSTOMER_CSRF_COOKIE, cookieBase());
  }

  async resolve(req: Request): Promise<CustomerContext | null> {
    const token = readCookie(req, CUSTOMER_COOKIE);
    if (!token) return null;
    const session = await this.prisma.customerSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.kind !== "CUSTOMER")
      return null;
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000)
      await this.prisma.customerSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    const { user, ...rest } = session;
    return { session: rest, user };
  }

  /** CSRF: double-submit token on every unsafe request made with the session cookie. */
  checkCsrf(req: Request, ctx: CustomerContext) {
    if (!UNSAFE.has(req.method)) return;
    const header = String(req.headers[CSRF_HEADER] ?? "");
    if (!header || !safeEqual(header, ctx.session.csrfToken))
      throw new ProblemException(
        403,
        "CSRF_INVALID",
        "This request couldn't be verified",
        "Reload the page and try again.",
      );
  }

  async signOut(ctx: CustomerContext) {
    await this.prisma.customerSession.update({ where: { id: ctx.session.id }, data: { revokedAt: new Date() } });
  }
}

/** Requires a signed-in customer (and the CSRF header on writes). */
@Injectable()
export class CustomerGuard implements CanActivate {
  constructor(private readonly auth: CustomerAuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { customer?: CustomerContext }>();
    const ctx = await this.auth.resolve(req);
    if (!ctx) throw new ProblemException(401, "UNAUTHENTICATED", "Please sign in with your mobile number");
    this.auth.checkCsrf(req, ctx);
    req.customer = ctx;
    return true;
  }
}

export const Customer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): CustomerContext =>
    ctx.switchToHttp().getRequest<Request & { customer: CustomerContext }>().customer,
);

export const customerView = (user: User) => ({
  id: user.id,
  phone: user.phoneE164,
  name: user.name,
  email: user.email,
  needsProfile: !user.name.trim(),
});
