import { execSync } from "node:child_process";

/**
 * Prepares the e2e database (URL set in vitest.config.mts): applies migrations,
 * resets website content and staff test accounts from earlier runs, and runs the idempotent seed.
 */
export default function setup() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/_test(\?|$)/.test(url)) throw new Error(`Refusing to run tests against a non-test database: ${url}`);
  execSync("npx prisma migrate deploy", { env: process.env, stdio: "pipe" });
  // Website content, staff accounts and custom roles are test fixtures: start each run from
  // the seed (test database only — guarded above).
  execSync("npx prisma db execute --stdin --schema prisma/schema.prisma", {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    input: [
      "DELETE FROM content_page_versions;",
      "DELETE FROM content_pages;",
      "DELETE FROM navigation_menus;",
      "DELETE FROM site_settings;",
      "DELETE FROM faq_items;",
      "DELETE FROM faq_topics;",
      "DELETE FROM media_assets;",
      "DELETE FROM redirects;",
      // Catalogue admin fixtures: drafts, test categories and visibility (the seed resets the rest).
      // Commerce fixtures: customers, carts and orders from earlier runs.
      // Sales fixtures: quotations and company accounts.
      "DELETE FROM quote_revisions;",
      "DELETE FROM quote_lines;",
      "DELETE FROM quotes;",
      "DELETE FROM quote_sequences;",
      "DELETE FROM company_members;",
      "DELETE FROM companies;",
      "DELETE FROM payment_events;",
      "DELETE FROM refunds;",
      "DELETE FROM payments;",
      "DELETE FROM order_events;",
      "DELETE FROM order_items;",
      "DELETE FROM orders;",
      "DELETE FROM cart_items;",
      "DELETE FROM carts;",
      "DELETE FROM customer_sessions;",
      "DELETE FROM otp_challenges;",
      "DELETE FROM users WHERE kind = 'CUSTOMER';",
      "DELETE FROM pricing_versions WHERE status IN ('DRAFT', 'SCHEDULED');",
      "DELETE FROM option_rules;",
      "DELETE FROM products WHERE slug LIKE 'test-%';",
      "DELETE FROM categories WHERE slug LIKE 'test-%';",
      "UPDATE categories SET is_visible = true;",
      "UPDATE products SET is_visible = true;",
      "DELETE FROM users WHERE kind = 'STAFF';",
      "DELETE FROM staff_roles WHERE is_system = false AND key NOT IN ('admin','content-editor','sales','pre-press','production','finance');",
    ].join(" "),
  });
  execSync("npx tsx prisma/seed.ts", { env: process.env, stdio: "pipe" });
}
