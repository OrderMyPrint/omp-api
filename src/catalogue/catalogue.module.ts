import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogueAdminController } from "./catalogue-admin.controller";
import { CatalogueAdminService } from "./catalogue-admin.service";
import { CatalogueController } from "./catalogue.controller";
import { CatalogueService } from "./catalogue.service";

@Module({
  imports: [AuthModule],
  controllers: [CatalogueController, CatalogueAdminController],
  providers: [CatalogueService, CatalogueAdminService],
  exports: [CatalogueService],
})
export class CatalogueModule {}
