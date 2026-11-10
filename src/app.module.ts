import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { CatalogueModule } from "./catalogue/catalogue.module";
import { CommerceModule } from "./commerce/commerce.module";
import { ContentModule } from "./content/content.module";
import { HealthController } from "./health/health.controller";
import { PricingModule } from "./pricing/pricing.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SalesModule } from "./sales/sales.module";

@Module({
  imports: [
    CommerceModule,
    // Per-instance rate limit. On Vercel each function instance counts separately,
    // so this is a first line of defence; the Vercel Firewall adds platform-wide limits.
    ThrottlerModule.forRoot({
      throttlers: [{ name: "default", ttl: 60_000, limit: 300 }],
      // Only the e2e suite sets this; it signs in many times from one address.
      skipIf: () => process.env.THROTTLE_DISABLED === "true",
    }),
    PrismaModule,
    CatalogueModule,
    PricingModule,
    AuthModule,
    ContentModule,
    SalesModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
