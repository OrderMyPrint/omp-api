import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { ProblemFilter } from "./common/problem";

export const API_PREFIX = "api/v1";

/** Browser origins allowed to call the API, from CORS_ORIGINS (comma-separated). */
export function allowedOrigins(value = process.env.CORS_ORIGINS ?? ""): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => /^https?:\/\/[^\s/]+$/.test(origin));
}

/** Applies the same configuration in production, on Vercel and in tests. */
export function configureApp(app: INestApplication): INestApplication {
  const express = app as NestExpressApplication;
  express.disable("x-powered-by");
  express.set("trust proxy", 1); // behind Vercel's proxy: real client IP for rate limiting
  express.useBodyParser("json", { limit: "100kb" });
  app.use(helmet());
  // Storefront origins may call public endpoints without credentials; only admin
  // origins may send the staff session cookie (credentials) to /admin routes.
  const storefront = new Set(allowedOrigins());
  const admin = new Set(allowedOrigins(process.env.ADMIN_ORIGINS ?? ""));
  app.enableCors((req: { headers: { origin?: string } }, cb: (err: Error | null, options: object) => void) => {
    const origin = req.headers.origin ?? "";
    if (admin.has(origin))
      return cb(null, {
        origin: true,
        credentials: true,
        methods: ["GET", "POST", "PATCH", "DELETE"],
        allowedHeaders: ["content-type", "x-csrf-token"],
        maxAge: 600,
      });
    if (storefront.has(origin))
      return cb(null, { origin: true, credentials: false, methods: ["GET", "POST"], maxAge: 600 });
    return cb(null, { origin: false });
  });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ProblemFilter());

  const config = new DocumentBuilder()
    .setTitle("Order My Print API")
    .setDescription("Catalogue and server-authoritative pricing. Money values are decimal strings in INR.")
    .setVersion("0.1.0")
    .build();
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: `${API_PREFIX}/openapi.json`,
  });
  return app;
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });
  return configureApp(app);
}
