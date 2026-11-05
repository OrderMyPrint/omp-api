import "reflect-metadata";
import { createApp } from "./setup";

/**
 * Server entrypoint. Vercel's NestJS support detects `src/app.ts` and runs this
 * app as a Vercel Function; locally it listens on PORT (default 4000).
 */
async function bootstrap() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}

void bootstrap();
