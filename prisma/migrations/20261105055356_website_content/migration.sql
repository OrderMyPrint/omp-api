-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('HOMEPAGE', 'CONTENT', 'SYSTEM', 'POLICY', 'LANDING');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "content_pages" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "PageType" NOT NULL DEFAULT 'CONTENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_page_versions" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "document" JSONB NOT NULL,
    "created_by_id" UUID,
    "published_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "content_page_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "navigation_menus" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "published" JSONB,
    "published_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "navigation_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "id" TEXT NOT NULL DEFAULT 'site',
    "draft" JSONB NOT NULL,
    "published" JSONB,
    "published_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_topics" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "faq_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faq_items" (
    "id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "show_on_homepage" BOOLEAN NOT NULL DEFAULT false,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "size_bytes" INTEGER,
    "alt" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redirects" (
    "id" UUID NOT NULL,
    "from_path" TEXT NOT NULL,
    "to_path" TEXT NOT NULL,
    "permanent" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_pages_key_key" ON "content_pages"("key");

-- CreateIndex
CREATE UNIQUE INDEX "content_pages_path_key" ON "content_pages"("path");

-- CreateIndex
CREATE UNIQUE INDEX "content_page_versions_page_id_version_no_key" ON "content_page_versions"("page_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "navigation_menus_key_key" ON "navigation_menus"("key");

-- CreateIndex
CREATE UNIQUE INDEX "faq_topics_key_key" ON "faq_topics"("key");

-- CreateIndex
CREATE INDEX "faq_items_topic_id_idx" ON "faq_items"("topic_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_url_key" ON "media_assets"("url");

-- CreateIndex
CREATE UNIQUE INDEX "redirects_from_path_key" ON "redirects"("from_path");

-- AddForeignKey
ALTER TABLE "content_page_versions" ADD CONSTRAINT "content_page_versions_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "content_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faq_items" ADD CONSTRAINT "faq_items_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "faq_topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one draft and one published version per page.
CREATE UNIQUE INDEX "content_page_versions_one_draft" ON "content_page_versions" ("page_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "content_page_versions_one_published" ON "content_page_versions" ("page_id") WHERE "status" = 'PUBLISHED';
-- Published and archived versions are history: their documents never change.
CREATE FUNCTION forbid_published_content_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND NEW.document IS DISTINCT FROM OLD.document THEN
    RAISE EXCEPTION 'Published page versions cannot be edited (version %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER content_page_versions_immutable BEFORE UPDATE ON "content_page_versions"
  FOR EACH ROW EXECUTE FUNCTION forbid_published_content_edit();
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_path_format" CHECK ("path" ~ '^/[a-z0-9/-]*$');
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_paths" CHECK ("from_path" ~ '^/' AND "to_path" ~ '^/' AND "from_path" <> "to_path");
