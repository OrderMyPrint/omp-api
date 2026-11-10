import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { CustomersService } from "./customers.service";
import { QuotesService } from "./quotes.service";
import { AdminCustomersController, AdminQuotesController, QuoteRequestsController } from "./sales.controllers";

/** Customers, company accounts and quotations (AD-CUS, AD-QUO). */
@Module({
  imports: [AuthModule, CatalogueModule],
  controllers: [QuoteRequestsController, AdminQuotesController, AdminCustomersController],
  providers: [CustomersService, QuotesService],
})
export class SalesModule {}
