-- CreateEnum
CREATE TYPE "CompanyRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'SENT', 'CLARIFICATION', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gstin" TEXT,
    "credit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "credit_terms_days" INTEGER,
    "credit_approved_by_id" UUID,
    "credit_approved_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_members" (
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "CompanyRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_members_pkey" PRIMARY KEY ("company_id","user_id")
);

-- CreateTable
CREATE TABLE "quote_sequences" (
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quote_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'REQUESTED',
    "source" TEXT NOT NULL,
    "contact" JSONB NOT NULL,
    "company_name" TEXT,
    "gstin" TEXT,
    "company_id" UUID,
    "customer_id" UUID,
    "assigned_to_id" UUID,
    "request" JSONB,
    "notes" TEXT,
    "override_reason" TEXT,
    "shipping_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "valid_until" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "sort" INTEGER NOT NULL,
    "product_id" UUID,
    "config" JSONB,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "engine_unit_price" DECIMAL(12,4),
    "unit_price" DECIMAL(12,4) NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "line_subtotal" DECIMAL(12,2) NOT NULL,
    "tax_amount" DECIMAL(12,2) NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_revisions" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "sent_by_id" UUID,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_gstin_key" ON "companies"("gstin");

-- CreateIndex
CREATE INDEX "company_members_user_id_idx" ON "company_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_number_key" ON "quotes"("number");

-- CreateIndex
CREATE INDEX "quotes_status_updated_at_idx" ON "quotes"("status", "updated_at");

-- CreateIndex
CREATE INDEX "quote_lines_quote_id_idx" ON "quote_lines"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_revisions_quote_id_revision_key" ON "quote_revisions"("quote_id", "revision");

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_revisions" ADD CONSTRAINT "quote_revisions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
