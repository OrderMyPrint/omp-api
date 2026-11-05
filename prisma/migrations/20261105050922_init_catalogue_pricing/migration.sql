-- CreateEnum
CREATE TYPE "QuantityMode" AS ENUM ('TIERS', 'SIZES');

-- CreateEnum
CREATE TYPE "UploadTiming" AS ENUM ('BEFORE_CART', 'AFTER_CHECKOUT', 'EITHER');

-- CreateEnum
CREATE TYPE "OptionGroupKind" AS ENUM ('SELECT', 'SWATCH', 'MULTISELECT');

-- CreateEnum
CREATE TYPE "PricingStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "tax_profiles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "hsn_sac" TEXT,
    "gst_rate" DECIMAL(5,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "tax_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "lead" TEXT NOT NULL,
    "about" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "lead" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "unit_one" TEXT NOT NULL,
    "unit_many" TEXT NOT NULL,
    "turnaround_min_days" INTEGER NOT NULL,
    "turnaround_max_days" INTEGER NOT NULL,
    "quantity_mode" "QuantityMode" NOT NULL DEFAULT 'TIERS',
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "default_sizes" JSONB,
    "upload_timing" "UploadTiming" NOT NULL DEFAULT 'EITHER',
    "specs" JSONB NOT NULL DEFAULT '[]',
    "uses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "materials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tax_profile_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_groups" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "short_label" TEXT,
    "hint" TEXT NOT NULL,
    "note" TEXT,
    "kind" "OptionGroupKind" NOT NULL DEFAULT 'SELECT',
    "step_order" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "default_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "options" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "swatch" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "unavailable_reason" TEXT,

    CONSTRAINT "options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_artwork_slots" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "print_area" TEXT NOT NULL,
    "bleed_mm" DECIMAL(5,1),
    "safe_mm" DECIMAL(5,1),
    "accepted_types" TEXT[] DEFAULT ARRAY['pdf', 'png', 'jpg', 'jpeg', 'svg', 'cdr']::TEXT[],
    "max_mb" INTEGER NOT NULL DEFAULT 50,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_artwork_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_versions" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "PricingStatus" NOT NULL DEFAULT 'DRAFT',
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "document" JSONB NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "pricing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_profiles_name_key" ON "tax_profiles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "option_groups_product_id_key_key" ON "option_groups"("product_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "options_group_id_key_key" ON "options"("group_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "product_artwork_slots_product_id_key_key" ON "product_artwork_slots"("product_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_versions_product_id_version_no_key" ON "pricing_versions"("product_id", "version_no");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tax_profile_id_fkey" FOREIGN KEY ("tax_profile_id") REFERENCES "tax_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_groups" ADD CONSTRAINT "option_groups_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options" ADD CONSTRAINT "options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_artwork_slots" ADD CONSTRAINT "product_artwork_slots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_versions" ADD CONSTRAINT "pricing_versions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity rules (docs/architecture/data-model.md §3) -------------------------

-- Only one PUBLISHED pricing version per product at a time.
CREATE UNIQUE INDEX "pricing_versions_one_published_per_product"
  ON "pricing_versions" ("product_id") WHERE "status" = 'PUBLISHED';

-- Published pricing documents are immutable: publish a new version instead.
CREATE FUNCTION forbid_published_pricing_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' AND NEW.document IS DISTINCT FROM OLD.document THEN
    RAISE EXCEPTION 'Published pricing versions cannot be edited (version %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pricing_versions_immutable
  BEFORE UPDATE ON "pricing_versions"
  FOR EACH ROW EXECUTE FUNCTION forbid_published_pricing_edit();

ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_gst_rate_range" CHECK ("gst_rate" >= 0 AND "gst_rate" <= 28);
ALTER TABLE "products" ADD CONSTRAINT "products_turnaround_order" CHECK ("turnaround_min_days" > 0 AND "turnaround_min_days" <= "turnaround_max_days");
ALTER TABLE "product_artwork_slots" ADD CONSTRAINT "artwork_slots_max_mb" CHECK ("max_mb" BETWEEN 1 AND 200);
