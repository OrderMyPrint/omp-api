import { execSync } from "node:child_process";

/**
 * Prepares the e2e database (URL set in vitest.config.mts). Migrations are
 * applied and the idempotent seed is run; nothing is truncated or dropped.
 */
export default function setup() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/_test(\?|$)/.test(url)) throw new Error(`Refusing to run tests against a non-test database: ${url}`);
  execSync("npx prisma migrate deploy", { env: process.env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { env: process.env, stdio: "pipe" });
}
