import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * One Prisma client per process. On Vercel each function instance reuses it
 * across requests; DATABASE_URL should be the provider's pooled URL there.
 * Connects lazily on the first query, so cold starts don't wait for the database.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
