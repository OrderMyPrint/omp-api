import { Injectable } from "@nestjs/common";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import type { Prisma, Role, StaffSession, User } from "@prisma/client";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, type AuditContext } from "./audit.service";
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUri, randomToken, sha256, verifyTotp } from "./crypto";
import { ALL_PERMISSIONS, OWNER_ROLE_KEY } from "./permissions";
import {
  IDLE_TTL_MS,
  INVITE_TTL_MS,
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  PENDING_TTL_MS,
  SESSION_TTL_MS,
  STEP_UP_TTL_MS,
} from "./session";

export type StaffContext = {
  session: StaffSession;
  user: User & { role: Role | null };
  permissions: Set<string>;
};

export type IssuedSession = { token: string; csrf: string; maxAgeMs: number };

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP 2024 Argon2id baseline
// Used when the email is unknown, so a failed sign-in takes the same time either way.
let dummyHash: Promise<string> | null = null;

export function validatePassword(password: string, email: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local))
    return "Don’t include your email name in the password.";
  return null;
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

export function permissionsOf(user: User & { role: Role | null }): Set<string> {
  if (!user.role) return new Set();
  // Owner always has everything, including permissions added after the role was created.
  return new Set(user.role.key === OWNER_ROLE_KEY ? ALL_PERMISSIONS : user.role.permissions);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(password: string) {
    return argonHash(password, ARGON);
  }

  private async newSession(
    userId: string,
    ctx: AuditContext,
    pending: boolean,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const token = randomToken();
    const csrf = randomToken(24);
    const ttl = pending ? PENDING_TTL_MS : SESSION_TTL_MS;
    await tx.staffSession.create({
      data: {
        tokenHash: sha256(token),
        userId,
        csrfToken: csrf,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        expiresAt: new Date(Date.now() + ttl),
        mfaVerifiedAt: pending ? null : new Date(),
      },
    });
    return { token, csrf, maxAgeMs: ttl };
  }

  /** Step 1 of sign-in: email + password. Always leads to a second factor. */
  async login(emailInput: string, password: string, ctx: AuditContext) {
    const email = normaliseEmail(emailInput);
    const user = await this.prisma.user.findUnique({ where: { email } });
    const invalid = () => new ProblemException(401, "INVALID_CREDENTIALS", "Email or password is incorrect");

    if (!user || user.kind !== "STAFF" || !user.passwordHash) {
      dummyHash ??= argonHash("not-a-real-password", ARGON);
      await argonVerify(await dummyHash, password).catch(() => false);
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil > new Date())
      throw new ProblemException(
        429,
        "ACCOUNT_LOCKED",
        "Too many attempts",
        "Try again in a few minutes or ask an Owner.",
        {
          retryAfter: user.lockedUntil.toISOString(),
        },
      );

    const ok = await argonVerify(user.passwordHash, password).catch(() => false);
    if (!ok || user.staffStatus !== "ACTIVE") {
      await this.recordFailure(user, ctx, ok ? "login.inactive" : "login.failed");
      throw invalid();
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    const session = await this.newSession(user.id, ctx, true);
    if (user.totpEnabledAt) return { session, next: "totp" as const };
    return { session, next: "enroll" as const, ...(await this.startEnrolment(user)) };
  }

  private async recordFailure(user: User, ctx: AuditContext, action: string) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil,
      },
    });
    await this.audit.record({ ...ctx, actorId: user.id }, lock ? "login.locked" : action, {
      type: "user",
      id: user.id,
    });
  }

  /** New authenticator secret, stored encrypted but not enabled until a code is verified. */
  private async startEnrolment(user: User) {
    const secret = newTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: encryptSecret(secret), totpLastStep: null },
    });
    return { totpSecret: secret, otpauthUri: otpauthUri(secret, user.email ?? "staff") };
  }

  private checkCode(user: User, code: string): number {
    if (!user.totpSecretEnc) throw new ProblemException(400, "TOTP_NOT_SET_UP", "Set up your authenticator first");
    const step = verifyTotp(decryptSecret(user.totpSecretEnc), code);
    if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep))
      throw new ProblemException(
        401,
        "INVALID_CODE",
        "That code didn’t work",
        "Enter the current 6-digit code from your authenticator app.",
      );
    return step;
  }

  /** Step 2: the authenticator code. Completes enrolment on first use, rotates the session token. */
  async verifySecondFactor(staff: StaffContext, code: string, ctx: AuditContext): Promise<IssuedSession> {
    const { user, session } = staff;
    let step: number;
    try {
      step = this.checkCode(user, code);
    } catch (error) {
      await this.recordFailure(user, ctx, "login.totp_failed");
      throw error;
    }
    const enrolling = !user.totpEnabledAt;
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          totpLastStep: step,
          failedLogins: 0,
          lastActiveAt: new Date(),
          ...(enrolling ? { totpEnabledAt: new Date() } : {}),
          ...(user.staffStatus === "INVITED" ? { staffStatus: "ACTIVE" } : {}),
        },
      });
      // Rotate: the pending token is revoked and a fresh full session is issued (no session fixation).
      await tx.staffSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      const issued = await this.newSession(user.id, ctx, false, tx);
      await this.audit.record(
        { ...ctx, actorId: user.id },
        enrolling ? "staff.2fa_enrolled" : "login.succeeded",
        { type: "user", id: user.id },
        undefined,
        tx,
      );
      return issued;
    });
  }

  /** Fresh authenticator code for sensitive changes (roles, staff, refunds…). */
  async stepUp(staff: StaffContext, code: string, ctx: AuditContext) {
    const step = this.checkCode(staff.user, code);
    await this.prisma.user.update({ where: { id: staff.user.id }, data: { totpLastStep: step } });
    await this.prisma.staffSession.update({ where: { id: staff.session.id }, data: { stepUpAt: new Date() } });
    await this.audit.record({ ...ctx, actorId: staff.user.id }, "auth.step_up", { type: "user", id: staff.user.id });
    return { stepUpValidUntil: new Date(Date.now() + STEP_UP_TTL_MS).toISOString() };
  }

  async logout(staff: StaffContext, ctx: AuditContext) {
    await this.prisma.staffSession.update({ where: { id: staff.session.id }, data: { revokedAt: new Date() } });
    await this.audit.record({ ...ctx, actorId: staff.user.id }, "logout", { type: "user", id: staff.user.id });
  }

  /** Accepts an invitation: sets the password and starts authenticator enrolment. */
  async acceptInvitation(token: string, password: string, ctx: AuditContext) {
    const invite = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date() || invite.user.staffStatus !== "INVITED")
      throw new ProblemException(
        410,
        "INVITATION_INVALID",
        "This invitation link has expired or was already used",
        "Ask an Owner to send a new invitation.",
      );
    const problem = validatePassword(password, invite.user.email ?? "");
    if (problem) throw new ProblemException(400, "PASSWORD_WEAK", "Choose a stronger password", problem);
    const passwordHash = await this.hashPassword(password);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: invite.userId },
        data: { passwordHash, failedLogins: 0, lockedUntil: null, totpEnabledAt: null },
      }),
      this.prisma.staffInvitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
    ]);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: invite.userId } });
    const session = await this.newSession(user.id, ctx, true);
    await this.audit.record({ ...ctx, actorId: user.id }, "staff.invitation_accepted", { type: "user", id: user.id });
    return { session, next: "enroll" as const, ...(await this.startEnrolment(user)) };
  }

  /** Creates (or renews) an invitation and returns the one-time link. */
  async issueInvitation(userId: string, invitedById: string | null, tx: Prisma.TransactionClient = this.prisma) {
    const token = randomToken();
    await tx.staffInvitation.updateMany({ where: { userId, acceptedAt: null }, data: { expiresAt: new Date() } });
    await tx.staffInvitation.create({
      data: { tokenHash: sha256(token), userId, invitedById, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
    const base = (process.env.ADMIN_APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");
    // Token in the URL fragment: never sent to servers or leaked in Referer headers.
    return {
      inviteUrl: `${base}/accept-invite#token=${token}`,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    };
  }

  /** Resolves a session cookie into the signed-in staff member (used by the guard). */
  async resolve(token: string): Promise<StaffContext | null> {
    const session = await this.prisma.staffSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { role: true } } },
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now) return null;
    if (session.mfaVerifiedAt && now - session.lastSeenAt.getTime() > IDLE_TTL_MS) return null;
    const { user, ...rest } = session;
    if (user.kind !== "STAFF" || user.staffStatus === "DEACTIVATED") return null;
    // Throttle last-seen writes to once a minute.
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.$transaction([
        this.prisma.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }),
        this.prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } }),
      ]);
    }
    return { session: rest as StaffSession, user, permissions: permissionsOf(user) };
  }
}
