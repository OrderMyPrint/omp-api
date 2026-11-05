import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";

/**
 * Server entrypoint. Vercel's NestJS preset detects `src/main.ts` importing
 * `@nestjs/core` and runs this app as a Vercel Function; locally it listens on
 * PORT (default 4000).
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}

void bootstrap();
