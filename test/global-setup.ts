import { execSync } from "node:child_process";

/**
 * Prepares the e2e database (URL set in vitest.config.mts): applies migrations,
 * removes staff test accounts from earlier runs, and runs the idempotent seed.
 */
export default function setup() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/_test(\?|$)/.test(url)) throw new Error(`Refusing to run tests against a non-test database: ${url}`);
  execSync("npx prisma migrate deploy", { env: process.env, stdio: "pipe" });
  // Staff accounts and custom roles are test fixtures: start each run clean (test database only).
  execSync("npx prisma db execute --stdin --schema prisma/schema.prisma", {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    input:
      "DELETE FROM users WHERE kind = 'STAFF'; DELETE FROM staff_roles WHERE is_system = false AND key NOT IN ('admin','content-editor','sales','pre-press','production','finance');",
  });
  execSync("npx tsx prisma/seed.ts", { env: process.env, stdio: "pipe" });
}
