import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogueAdminController } from "./catalogue-admin.controller";
import { CatalogueAdminService } from "./catalogue-admin.service";
import { CatalogueStructureService } from "./catalogue-structure.service";
import { CatalogueController } from "./catalogue.controller";
import { CatalogueService } from "./catalogue.service";
import { PricingActivation } from "./pricing-activation";

@Module({
  imports: [AuthModule],
  controllers: [CatalogueController, CatalogueAdminController],
  providers: [CatalogueService, CatalogueAdminService, CatalogueStructureService, PricingActivation],
  exports: [CatalogueService],
})
export class CatalogueModule {}
