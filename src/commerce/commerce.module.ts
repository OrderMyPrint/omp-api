import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CatalogueModule } from "../catalogue/catalogue.module";
import { PAYMENT_PROVIDERS, SMS_SENDER, paymentProvidersFromEnv, smsSenderFromEnv } from "../providers/providers";
import { CartService } from "./cart.service";
import {
  AdminOrdersController,
  CartController,
  CheckoutController,
  CustomerAuthController,
  PaymentsController,
} from "./commerce.controllers";
import { CustomerAuthService, CustomerGuard } from "./customer-auth";
import { OrdersService } from "./orders.service";

/** Customers, cart, checkout, payments and orders. */
@Module({
  imports: [AuthModule, CatalogueModule],
  controllers: [CustomerAuthController, CartController, CheckoutController, PaymentsController, AdminOrdersController],
  providers: [
    { provide: SMS_SENDER, useFactory: smsSenderFromEnv },
    { provide: PAYMENT_PROVIDERS, useFactory: paymentProvidersFromEnv },
    CustomerAuthService,
    CustomerGuard,
    CartService,
    OrdersService,
  ],
})
export class CommerceModule {}
