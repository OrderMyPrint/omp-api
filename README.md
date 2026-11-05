# Order My Print — API

Backend for **Order My Print** (custom printing, India, INR): NestJS 11 + PostgreSQL (Prisma), deployed as a Vercel
Function (decision D-02, gate G2). Requirements, architecture and decisions live in the docs repository
[`OrderMyPrint/website`](https://github.com/OrderMyPrint/website) — see `docs/architecture/` and
`docs/approvals/G2-architecture-approval.md`.

> **Status: Phase 3 — catalogue, server-authoritative pricing, and staff sign-in with roles (RBAC).** Prices are researched reference rates from
> the approved design, **not** confirmed business prices (D-08); GST rates await CA confirmation (D-28). Nothing is
> deployed yet (G8).

## What it does today

| Method | Path                                    | Purpose                                                                |
| ------ | --------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/v1/health`                        | Liveness and database reachability                                     |
| GET    | `/api/v1/catalogue/categories`          | Visible categories with product counts                                 |
| GET    | `/api/v1/catalogue/products?category=&q=` | Listing, by category or search text                                  |
| GET    | `/api/v1/catalogue/products/{slug}`     | Product with option schema, artwork slots, price tiers                 |
| POST   | `/api/v1/pricing/preview`               | Price a configuration with the product's published pricing version     |
| GET    | `/api/v1/docs`, `/api/v1/openapi.json`  | Interactive docs and the OpenAPI document (for generated clients)      |

Example:

```bash
curl -X POST http://localhost:4000/api/v1/pricing/preview \
  -H 'content-type: application/json' \
  -d '{"productSlug":"visiting-cards","quantity":500,"selections":{"size":"standard","paper":"premium-matte-350","sides":"double","finish":"soft-touch","corners":"square"}}'
# → "subtotal": "1400.00", "gst": "252.00", "total": "1652.00"  (matches the approved Figma design)
```

Conventions (from `docs/architecture/api-specification.md`): JSON, money as decimal strings, errors as RFC 9457
`application/problem+json` with a machine `code`. Invalid configurations return `200` with `valid: false` and field
errors so the configurator can show them inline; malformed requests return `400 REQUEST_INVALID`.

## Staff sign-in and roles (RBAC)

Admin routes live under `/api/v1/admin/*` and are used by the separate admin app (`OrderMyPrint/omp-admin`).

- **Sign-in:** email + password (Argon2id) → authenticator code (TOTP, RFC 6238). The session is an httpOnly,
  `SameSite=Lax` cookie (12 h, signed out after 2 h idle); the token is stored only as a SHA-256 hash and rotated
  when the second factor succeeds. Writes need the `X-CSRF-Token` header (double-submit). 5 failed attempts lock the
  account for 15 minutes. TOTP secrets are encrypted at rest (AES-256-GCM, `STAFF_SECRET_KEY`) and a code is never
  accepted twice.
- **Roles:** bundles of permission keys from `src/auth/permissions.ts` (41 keys in 15 modules, matching the Figma role
  editor AD-STF-02). Default roles: Owner (locked, every permission), Admin, Content editor, Sales, Pre-press,
  Production, Finance. Every route declares `@RequirePermissions(...)`; role and staff changes also need a fresh code
  (`POST /admin/auth/step-up`, valid 5 minutes).
- **Safeguards:** at least one active Owner always remains; nobody changes their own role or status; deactivation
  signs the person out everywhere; the Owner role can't be edited or deleted.
- **Audit log:** every sign-in, invitation, role and staff change is written to `audit_logs`, which the database makes
  append-only (UPDATE/DELETE raise an error).
- **CORS:** only `ADMIN_ORIGINS` may send credentials; storefront origins (`CORS_ORIGINS`) get public endpoints only.

First Owner (once per environment, after `db:migrate` and `db:seed`):

```bash
npm run admin:create-owner -- --email owner@company.com --name "Full Name"
```

It prints a single-use invitation link (7 days). The Owner opens it in the admin app, sets a password and scans the
authenticator QR code; further staff are invited from Staff & roles. No email provider is chosen yet (D-07), so
invitation links are shown to the inviting Owner to share directly.

| Endpoint | Permission |
| --- | --- |
| `POST /admin/auth/login`, `/admin/auth/totp`, `/admin/auth/invitations/accept`, `/admin/auth/step-up`, `/admin/auth/logout`, `GET /admin/auth/me` | — (sign-in flow) |
| `GET /admin/staff`, `/admin/staff/{id}`, `/admin/roles`, `/admin/permissions` | `staff.read` |
| `POST /admin/staff/invitations`, `PATCH /admin/staff/{id}`, `POST /admin/staff/{id}/reset-2fa`, `/revoke-sessions` | `staff.manage` + step-up |
| `POST /admin/roles`, `PATCH/DELETE /admin/roles/{id}` | `roles.manage` + step-up |
| `GET /admin/audit` | `audit.read` |

## Getting started

Requires Node 22.12+ and PostgreSQL 16+.

```bash
npm install                 # also runs prisma generate
cp .env.example .env        # set DATABASE_URL / DATABASE_URL_UNPOOLED
npm run db:migrate          # apply migrations
npm run db:seed             # load the reference catalogue (idempotent)
npm run dev                 # http://localhost:4000/api/v1/docs
```

| Script             | What it does                                                           |
| ------------------ | ---------------------------------------------------------------------- |
| `npm run check`    | Prettier check + type check + all tests                                |
| `npm test`         | Unit tests (pricing engine) and e2e tests (HTTP + test database)       |
| `npm run build`    | Prisma client + TypeScript build into `dist/`                          |
| `npm run db:migrate` / `db:seed` | Apply migrations / load reference data                   |

E2E tests use `TEST_DATABASE_URL` (default: the local `omp_api_test` database). The setup refuses any database whose
name doesn't end in `_test`, applies migrations and runs the idempotent seed; it never truncates or drops anything.

## Design

```
src/
  main.ts                Entrypoint — imports @nestjs/core directly so Vercel detects NestJS
  setup.ts               Shared app configuration: prefix, helmet, CORS allow-list, body limit, errors, OpenAPI
  catalogue/             Categories and products (read model from PostgreSQL)
  pricing/
    pricing-document.ts  Zod schema of the versioned pricing document (data, never code)
    engine.ts            Pure pricing engine — decimal.js, HALF-UP to ₹0.01, field-level validation
  common/                Problem-details errors, money helpers
  prisma/                Prisma client provider
prisma/
  schema.prisma          Catalogue, tax profiles, versioned pricing
  migrations/            Includes integrity rules: one published price version per product,
                         published documents immutable, GST and turnaround checks
  seed.ts, reference/    Reference catalogue copied from the storefront (D-08 rates)
```

- **The server decides the price.** Each product has versioned pricing documents (`DRAFT → PUBLISHED → ARCHIVED`); only
  one is published at a time (partial unique index) and a published document cannot be edited (trigger). Every price
  response names the `pricingVersionId` it used, so carts and orders can snapshot it.
- **No invented prices.** Options without a researched price are stored as unavailable ("Priced on quotation").
- **Vercel specifics.** One Prisma client per function instance; use the provider's pooled URL for `DATABASE_URL`
  and the direct URL for `DATABASE_URL_UNPOOLED` (migrations). `vercel.json` pins the Mumbai region (`bom1`) to keep
  functions near Indian customers; confirm against the database region before staging.

## Not built yet

Next slices, in the order the architecture plan sets: artwork uploads (needs storage D-05 and hosted malware scanning
D-29), cart with server re-pricing, OTP sign-in (SMS provider D-25), checkout and orders, quotations, payments (D-06),
admin endpoints with staff 2FA, background jobs via Vercel Cron, audit log.

## Rules

- No secrets, credentials or customer data in Git — this repository is **public** (Director's choice at G2).
  Only `.env.example` is committed.
- Business rules live here, not in the frontends; the storefront and admin consume the OpenAPI-generated client.
- Money is never a float: `NUMERIC` in the database, decimal strings on the wire, `decimal.js` in maths.
