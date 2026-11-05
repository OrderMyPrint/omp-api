import { Module } from "@nestjs/common";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { PricingController } from "./pricing.controller";

@Module({ imports: [CatalogueModule], controllers: [PricingController] })
export class PricingModule {}
