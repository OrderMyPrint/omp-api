import type { Request, Response } from "express";

/** Cookie names and lifetimes for staff sessions (admin app). */
export const SESSION_COOKIE = "omp_staff_session";
export const CSRF_COOKIE = "omp_staff_csrf";
export const CSRF_HEADER = "x-csrf-token";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // absolute lifetime of a signed-in session
export const PENDING_TTL_MS = 10 * 60 * 1000; // password OK, waiting for the authenticator code
export const IDLE_TTL_MS = 2 * 60 * 60 * 1000; // signed out after 2 h without activity
export const STEP_UP_TTL_MS = 5 * 60 * 1000; // sensitive changes need a fresh code within 5 min

export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secureCookies = () => (process.env.COOKIE_SECURE ?? "true") !== "false";

function baseCookie() {
  const domain = process.env.COOKIE_DOMAIN?.trim();
  return {
    path: "/",
    sameSite: "lax" as const,
    secure: secureCookies(),
    ...(domain ? { domain } : {}),
  };
}

export function setSessionCookies(res: Response, token: string, csrf: string, maxAgeMs: number) {
  res.cookie(SESSION_COOKIE, token, { ...baseCookie(), httpOnly: true, maxAge: maxAgeMs });
  // Readable by the admin app so it can echo it in the X-CSRF-Token header (double-submit).
  res.cookie(CSRF_COOKIE, csrf, { ...baseCookie(), httpOnly: false, maxAge: maxAgeMs });
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(SESSION_COOKIE, baseCookie());
  res.clearCookie(CSRF_COOKIE, baseCookie());
}

/** Minimal cookie header parser (no dependency needed for two cookies). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export const clientIp = (req: Request) => (req.ip ?? "").slice(0, 64) || null;
export const userAgent = (req: Request) => (req.headers["user-agent"] ?? "").slice(0, 300) || null;
