import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// E2E tests use a separate database: TEST_DATABASE_URL, or the local omp_api_test.
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/omp_api_test`;
const testEnv = {
  DATABASE_URL: testDatabaseUrl,
  DATABASE_URL_UNPOOLED: testDatabaseUrl,
  CORS_ORIGINS: "http://localhost:3000",
};
Object.assign(process.env, testEnv); // for test/global-setup.ts (runs in this process)

// SWC keeps decorator metadata, which NestJS dependency injection needs in e2e tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.e2e.test.ts"],
    environment: "node",
    env: testEnv,
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
  },
});
