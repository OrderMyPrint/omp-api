import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { CatalogueModule } from "./catalogue/catalogue.module";
import { HealthController } from "./health/health.controller";
import { PricingModule } from "./pricing/pricing.module";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [
    // Per-instance rate limit. On Vercel each function instance counts separately,
    // so this is a first line of defence; the Vercel Firewall adds platform-wide limits.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
    PrismaModule,
    CatalogueModule,
    PricingModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
