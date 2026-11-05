import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type AuditContext = {
  actorId?: string | null;
  actorKind?: "staff" | "system";
  ip?: string | null;
  userAgent?: string | null;
};

/** Writes to the append-only audit log. Never pass secrets, tokens or password hashes. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    ctx: AuditContext,
    action: string,
    target?: { type: string; id: string },
    change?: { before?: unknown; after?: unknown },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        actorId: ctx.actorId ?? null,
        actorKind: ctx.actorKind ?? "staff",
        action,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
        before: (change?.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (change?.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      },
    });
  }
}
