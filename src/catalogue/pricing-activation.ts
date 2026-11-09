import { Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../auth/audit.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Scheduled pricing versions go live at their effectiveFrom. There is no background worker on
 * Vercel, so every catalogue read calls `activateDue()` first: one cheap query when nothing is due.
 */
@Injectable()
export class PricingActivation {
  private readonly logger = new Logger("PricingActivation");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async activateDue(now = new Date()) {
    const due = await this.prisma.pricingVersion.findMany({
      where: { status: "SCHEDULED", effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: "asc" },
    });
    for (const version of due) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            // Claim it first so two concurrent reads can't both activate it.
            const claimed = await tx.pricingVersion.updateMany({
              where: { id: version.id, status: "SCHEDULED" },
              data: { status: "DRAFT" },
            });
            if (!claimed.count) return;
            const current = await tx.pricingVersion.findFirst({
              where: { productId: version.productId, status: "PUBLISHED" },
            });
            if (current)
              await tx.pricingVersion.update({
                where: { id: current.id },
                data: { status: "ARCHIVED", effectiveTo: version.effectiveFrom },
              });
            await tx.pricingVersion.update({
              where: { id: version.id },
              data: { status: "PUBLISHED", publishedAt: now },
            });
            await this.audit.record(
              { actorKind: "system" },
              "pricing.version_activated",
              { type: "pricing_version", id: version.id },
              {
                before: current ? { versionId: current.id, versionNo: current.versionNo } : undefined,
                after: {
                  productId: version.productId,
                  versionNo: version.versionNo,
                  scheduledFor: version.effectiveFrom,
                },
              },
              tx,
            );
          },
          { timeout: 20_000, maxWait: 10_000 },
        );
      } catch (error) {
        // Another request activated it first; the next read sees the result.
        this.logger.warn(`Could not activate pricing ${version.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return due.length;
  }
}
