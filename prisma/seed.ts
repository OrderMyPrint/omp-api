/**
 * Seeds the catalogue and version-1 pricing from the reference data used by
 * the approved Figma design (prisma/reference/catalogue.ts, copied from the
 * storefront). These are researched market reference rates, NOT confirmed
 * business prices (D-08), and the GST rates await CA confirmation (D-28).
 *
 * Idempotent: re-running updates the catalogue and only creates a new pricing
 * version when the document has changed.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { categories, products, type ConfigStep } from "./reference/catalogue";
import { canonical, pricingDocumentFor } from "./seed-helpers";
import { DEFAULT_ROLES, OWNER_ROLE_KEY } from "../src/auth/permissions";
import { seedContent } from "./seed-content";

const prisma = new PrismaClient();
const kindFor = (step: ConfigStep) =>
  step.kind === "multi" ? "MULTISELECT" : step.kind === "swatch" ? "SWATCH" : "SELECT";

async function main() {
  const taxProfiles = new Map<number, string>();
  for (const rate of [...new Set(products.map((product) => product.gstRate))]) {
    const percent = Math.round(rate * 100);
    const name =
      percent === 5 ? "Garments 5% (D-28: CA to confirm)" : `Printed products ${percent}% (D-28: CA to confirm)`;
    const profile = await prisma.taxProfile.upsert({
      where: { name },
      update: { gstRate: String(percent) },
      create: {
        name,
        gstRate: String(percent),
        note: "Rate used by the approved design; HSN/SAC and rate await CA confirmation (D-28).",
      },
    });
    taxProfiles.set(rate, profile.id);
  }

  for (const [index, category] of categories.entries()) {
    const data = {
      name: category.name,
      summary: category.summary,
      lead: category.lead,
      about: category.about,
      imageUrl: category.image,
      sort: index,
    };
    await prisma.category.upsert({
      where: { slug: category.slug },
      update: data,
      create: { slug: category.slug, ...data },
    });
  }

  for (const [index, product] of products.entries()) {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: product.category } });
    const [min, max] = product.turnaround.split("–").map(Number);
    const sizes = product.quantity.kind === "sizes" ? product.quantity : undefined;
    const data = {
      categoryId: category.id,
      name: product.name,
      summary: product.summary,
      lead: product.lead,
      description: product.description,
      imageUrl: product.image,
      sort: index,
      unitOne: product.unitNoun.one,
      unitMany: product.unitNoun.many,
      turnaroundMinDays: min,
      turnaroundMaxDays: max ?? min,
      quantityMode: sizes ? ("SIZES" as const) : ("TIERS" as const),
      sizes: sizes?.sizes ?? [],
      defaultSizes: sizes ? (sizes.defaults as Prisma.InputJsonValue) : undefined,
      specs: product.specs.map(([label, value]) => ({ label, value })) as Prisma.InputJsonValue,
      uses: product.uses,
      materials: product.materials,
      taxProfileId: taxProfiles.get(product.gstRate)!,
    };
    const saved = await prisma.product.upsert({
      where: { slug: product.slug },
      update: data,
      create: { slug: product.slug, ...data },
    });

    await prisma.$transaction(async (tx) => {
      await tx.optionGroup.deleteMany({ where: { productId: saved.id } });
      for (const [stepOrder, step] of product.steps.entries()) {
        await tx.optionGroup.create({
          data: {
            productId: saved.id,
            key: step.id,
            label: step.title,
            shortLabel: step.short ?? null,
            hint: step.hint,
            note: step.note ?? null,
            kind: kindFor(step),
            stepOrder,
            defaultKeys: step.kind === "multi" ? step.defaultIds : [step.defaultId],
            options: {
              create: step.choices.map((choice, sort) => ({
                key: choice.id,
                label: choice.label,
                detail: choice.detail ?? null,
                swatch: choice.swatch ?? null,
                sort,
                isAvailable: !choice.unavailable,
                unavailableReason: choice.unavailable ?? null,
              })),
            },
          },
        });
      }
      await tx.artworkSlot.deleteMany({ where: { productId: saved.id } });
      await tx.artworkSlot.createMany({
        data: product.artwork.slots.map((label, sort) => ({
          productId: saved.id,
          key: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          label,
          printArea: product.artwork.printArea,
          bleedMm: "3",
          safeMm: "3",
          sort,
        })),
      });

      const document = pricingDocumentFor(product);
      const current = await tx.pricingVersion.findFirst({ where: { productId: saved.id, status: "PUBLISHED" } });
      if (current && canonical(current.document) === canonical(document)) return;
      const last = await tx.pricingVersion.aggregate({ where: { productId: saved.id }, _max: { versionNo: true } });
      if (current)
        await tx.pricingVersion.update({
          where: { id: current.id },
          data: { status: "ARCHIVED", effectiveTo: new Date() },
        });
      await tx.pricingVersion.create({
        data: {
          productId: saved.id,
          versionNo: (last._max.versionNo ?? 0) + 1,
          status: "PUBLISHED",
          document: document as Prisma.InputJsonValue,
          note: "Seeded from reference data (D-08)",
          publishedAt: new Date(),
        },
      });
    });
  }

  // Staff roles: created once (later edits by an Owner are kept); Owner is always synced to every permission.
  for (const role of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: role.key } });
    if (!existing) await prisma.role.create({ data: role });
    else if (role.key === OWNER_ROLE_KEY)
      await prisma.role.update({ where: { key: role.key }, data: { permissions: role.permissions, isSystem: true } });
  }

  await seedContent(prisma);

  const counts = await Promise.all([
    prisma.category.count(),
    prisma.product.count(),
    prisma.pricingVersion.count({ where: { status: "PUBLISHED" } }),
  ]);
  console.log(`Seeded ${counts[0]} categories, ${counts[1]} products, ${counts[2]} published pricing versions.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
