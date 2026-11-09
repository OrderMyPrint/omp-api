-- CreateEnum
CREATE TYPE "RuleEffect" AS ENUM ('EXCLUDES', 'REQUIRES');

-- AlterEnum
ALTER TYPE "PricingStatus" ADD VALUE 'SCHEDULED';

-- CreateTable
CREATE TABLE "option_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "when_group" TEXT NOT NULL,
    "when_option" TEXT NOT NULL,
    "effect" "RuleEffect" NOT NULL,
    "then_group" TEXT NOT NULL,
    "then_options" TEXT[],
    "message" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "option_rules_product_id_idx" ON "option_rules"("product_id");

-- AddForeignKey
ALTER TABLE "option_rules" ADD CONSTRAINT "option_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one draft per product (the API also refuses a second pending version).
CREATE UNIQUE INDEX "pricing_versions_one_draft_per_product" ON "pricing_versions"("product_id") WHERE "status" = 'DRAFT';
