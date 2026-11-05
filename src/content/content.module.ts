import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { AdminContentController, ContentController } from "./content.controllers";
import { ContentService } from "./content.service";

@Module({
  imports: [AuthModule, CatalogueModule],
  controllers: [ContentController, AdminContentController],
  providers: [ContentService],
})
export class ContentModule {}
