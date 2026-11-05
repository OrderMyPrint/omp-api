import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, type AuditContext } from "./audit.service";
import { AuthService, normaliseEmail, type StaffContext } from "./auth.service";
import { OWNER_ROLE_KEY, PERMISSIONS, invalidPermissions } from "./permissions";

const staffView = {
  id: true,
  email: true,
  name: true,
  staffStatus: true,
  totpEnabledAt: true,
  lastActiveAt: true,
  createdAt: true,
  role: { select: { id: true, key: true, name: true } },
} satisfies Prisma.UserSelect;

type StaffRow = Prisma.UserGetPayload<{ select: typeof staffView }>;

const present = (u: StaffRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  status: u.staffStatus,
  twoFactor: Boolean(u.totpEnabledAt),
  lastActiveAt: u.lastActiveAt,
  createdAt: u.createdAt,
  role: u.role,
});

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "role";

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  // ----------------------------------------------------------------- staff

  async list() {
    const rows = await this.prisma.user.findMany({
      where: { kind: "STAFF" },
      select: staffView,
      orderBy: [{ staffStatus: "asc" }, { name: "asc" }],
    });
    return rows.map(present);
  }

  async get(id: string) {
    const row = await this.prisma.user.findFirst({ where: { id, kind: "STAFF" }, select: staffView });
    if (!row) throw new ProblemException(404, "STAFF_NOT_FOUND", "Staff member not found");
    const sessions = await this.prisma.staffSession.count({
      where: { userId: id, revokedAt: null, mfaVerifiedAt: { not: null }, expiresAt: { gt: new Date() } },
    });
    return { ...present(row), activeSessions: sessions };
  }

  async invite(actor: StaffContext, input: { email: string; name: string; roleId: string }, ctx: AuditContext) {
    const email = normaliseEmail(input.email);
    const role = await this.prisma.role.findUnique({ where: { id: input.roleId } });
    if (!role) throw new ProblemException(400, "ROLE_NOT_FOUND", "Choose a valid role");
    if (role.key === OWNER_ROLE_KEY && !actor.permissions.has("roles.manage"))
      throw new ProblemException(403, "FORBIDDEN", "Only an Owner can invite another Owner");
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && (existing.kind !== "STAFF" || existing.staffStatus !== "INVITED"))
      throw new ProblemException(409, "EMAIL_IN_USE", "This email already has an account");

    return this.prisma.$transaction(async (tx) => {
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { name: input.name.trim(), roleId: role.id } })
        : await tx.user.create({
            data: { kind: "STAFF", email, name: input.name.trim(), staffStatus: "INVITED", roleId: role.id },
          });
      const invitation = await this.auth.issueInvitation(user.id, actor.user.id, tx);
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "staff.invited",
        { type: "user", id: user.id },
        { after: { email, role: role.key } },
        tx,
      );
      // No email provider yet (D-07): the Owner shares this one-time link directly.
      return {
        staff: present({ ...user, role: { id: role.id, key: role.key, name: role.name } } as StaffRow),
        ...invitation,
      };
    });
  }

  private async activeOwnerCount(tx: Prisma.TransactionClient, excludeUserId?: string) {
    return tx.user.count({
      where: {
        kind: "STAFF",
        staffStatus: "ACTIVE",
        role: { key: OWNER_ROLE_KEY },
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
    });
  }

  async update(
    actor: StaffContext,
    id: string,
    input: { name?: string; roleId?: string; status?: "ACTIVE" | "DEACTIVATED" },
    ctx: AuditContext,
  ) {
    if (id === actor.user.id && (input.roleId || input.status))
      throw new ProblemException(
        409,
        "SELF_CHANGE_FORBIDDEN",
        "You can’t change your own role or status",
        "Ask another Owner.",
      );
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id, kind: "STAFF" }, include: { role: true } });
      if (!user) throw new ProblemException(404, "STAFF_NOT_FOUND", "Staff member not found");
      const role = input.roleId ? await tx.role.findUnique({ where: { id: input.roleId } }) : user.role;
      if (input.roleId && !role) throw new ProblemException(400, "ROLE_NOT_FOUND", "Choose a valid role");
      if (role?.key === OWNER_ROLE_KEY && user.role?.key !== OWNER_ROLE_KEY && !actor.permissions.has("roles.manage"))
        throw new ProblemException(403, "FORBIDDEN", "Only an Owner can make someone an Owner");
      if (input.status === "ACTIVE" && user.staffStatus === "INVITED")
        throw new ProblemException(409, "INVITATION_PENDING", "This person hasn’t accepted their invitation yet");

      const losingOwner =
        user.role?.key === OWNER_ROLE_KEY &&
        user.staffStatus === "ACTIVE" &&
        (role?.key !== OWNER_ROLE_KEY || input.status === "DEACTIVATED");
      if (losingOwner && (await this.activeOwnerCount(tx, user.id)) === 0)
        throw new ProblemException(
          409,
          "LAST_OWNER",
          "At least one active Owner is required",
          "Make someone else an Owner first.",
        );

      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.roleId ? { roleId: input.roleId } : {}),
          ...(input.status ? { staffStatus: input.status } : {}),
        },
        select: staffView,
      });
      if (input.status === "DEACTIVATED")
        await tx.staffSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "staff.updated",
        { type: "user", id },
        {
          before: { name: user.name, role: user.role?.key, status: user.staffStatus },
          after: { name: updated.name, role: updated.role?.key, status: updated.staffStatus },
        },
        tx,
      );
      return present(updated);
    });
  }

  async resetTwoFactor(actor: StaffContext, id: string, ctx: AuditContext) {
    if (id === actor.user.id)
      throw new ProblemException(409, "SELF_CHANGE_FORBIDDEN", "Ask another Owner to reset your 2FA");
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({ where: { id, kind: "STAFF" } });
      if (!user) throw new ProblemException(404, "STAFF_NOT_FOUND", "Staff member not found");
      await tx.user.update({ where: { id }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } });
      await tx.staffSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "staff.2fa_reset",
        { type: "user", id },
        undefined,
        tx,
      );
    });
    return { reset: true };
  }

  async revokeSessions(actor: StaffContext, id: string, ctx: AuditContext) {
    const { count } = await this.prisma.staffSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "staff.sessions_revoked",
      { type: "user", id },
      { after: { count } },
    );
    return { revoked: count };
  }

  // ----------------------------------------------------------------- roles

  permissionCatalogue() {
    const modules = new Map<string, { key: string; label: string }[]>();
    for (const p of PERMISSIONS)
      modules.set(p.module, [...(modules.get(p.module) ?? []), { key: p.key, label: p.label }]);
    return [...modules.entries()].map(([module, permissions]) => ({ module, permissions }));
  }

  async roles() {
    const rows = await this.prisma.role.findMany({
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: { _count: { select: { users: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      locked: r.isSystem,
      permissions: r.key === OWNER_ROLE_KEY ? PERMISSIONS.map((p) => p.key) : r.permissions,
      members: r._count.users,
    }));
  }

  private checkPermissions(keys: string[]) {
    const bad = invalidPermissions(keys);
    if (bad.length)
      throw new ProblemException(400, "PERMISSION_UNKNOWN", "Unknown permission", bad.join(", "), { unknown: bad });
    return [...new Set(keys)].sort();
  }

  async createRole(
    actor: StaffContext,
    input: { name: string; description?: string; permissions: string[] },
    ctx: AuditContext,
  ) {
    const permissions = this.checkPermissions(input.permissions);
    const name = input.name.trim();
    let key = slug(name);
    if (key === OWNER_ROLE_KEY || (await this.prisma.role.findUnique({ where: { key } })))
      key = `${key}-${Date.now().toString(36)}`;
    if (await this.prisma.role.findUnique({ where: { name } }))
      throw new ProblemException(409, "ROLE_EXISTS", "A role with this name already exists");
    const role = await this.prisma.role.create({
      data: { key, name, description: input.description?.trim() ?? "", permissions },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "role.created",
      { type: "role", id: role.id },
      { after: { name, permissions } },
    );
    return role;
  }

  async updateRole(
    actor: StaffContext,
    id: string,
    input: { name?: string; description?: string; permissions?: string[] },
    ctx: AuditContext,
  ) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new ProblemException(404, "ROLE_NOT_FOUND", "Role not found");
    if (role.isSystem) throw new ProblemException(409, "ROLE_LOCKED", "The Owner role can’t be edited");
    const permissions = input.permissions ? this.checkPermissions(input.permissions) : undefined;
    if (
      input.name &&
      input.name.trim() !== role.name &&
      (await this.prisma.role.findUnique({ where: { name: input.name.trim() } }))
    )
      throw new ProblemException(409, "ROLE_EXISTS", "A role with this name already exists");
    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(permissions ? { permissions } : {}),
      },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "role.updated",
      { type: "role", id },
      {
        before: { name: role.name, permissions: role.permissions },
        after: { name: updated.name, permissions: updated.permissions },
      },
    );
    return updated;
  }

  async deleteRole(actor: StaffContext, id: string, ctx: AuditContext) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new ProblemException(404, "ROLE_NOT_FOUND", "Role not found");
    if (role.isSystem) throw new ProblemException(409, "ROLE_LOCKED", "The Owner role can’t be deleted");
    if (role._count.users)
      throw new ProblemException(409, "ROLE_IN_USE", "Move this role’s members to another role first");
    await this.prisma.role.delete({ where: { id } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "role.deleted",
      { type: "role", id },
      { before: { name: role.name, permissions: role.permissions } },
    );
    return { deleted: true };
  }

  // ----------------------------------------------------------------- audit

  async auditLog(filter: { targetType?: string; targetId?: string; actorId?: string; cursor?: string; limit: number }) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(filter.targetType ? { targetType: filter.targetType } : {}),
        ...(filter.targetId ? { targetId: filter.targetId } : {}),
        ...(filter.actorId ? { actorId: filter.actorId } : {}),
        ...(filter.cursor ? { at: { lt: new Date(filter.cursor) } } : {}),
      },
      orderBy: { at: "desc" },
      take: filter.limit + 1,
    });
    const page = rows.slice(0, filter.limit);
    return { items: page, nextCursor: rows.length > filter.limit ? page[page.length - 1].at.toISOString() : null };
  }
}
