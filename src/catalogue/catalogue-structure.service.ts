import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AuditService, type AuditContext } from "../auth/audit.service";
import type { StaffContext } from "../auth/auth.service";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";
import { parsePricingDocument } from "../pricing/pricing-document";
import { CatalogueAdminService, notFound } from "./catalogue-admin.service";

const TX = { timeout: 20_000, maxWait: 10_000 };

export type NewProduct = {
  slug: string;
  name: string;
  categoryId: string;
  summary: string;
  unitOne: string;
  unitMany: string;
  quantityMode: "TIERS" | "SIZES";
  sizes?: string[];
  taxProfileId: string;
  turnaroundMinDays: number;
  turnaroundMaxDays: number;
};
export type NewGroup = {
  key: string;
  label: string;
  shortLabel?: string | null;
  hint: string;
  kind: "SELECT" | "SWATCH" | "MULTISELECT";
  required: boolean;
};
export type GroupPatch = {
  label?: string;
  shortLabel?: string | null;
  hint?: string;
  note?: string | null;
  required?: boolean;
  defaultKeys?: string[];
};
export type NewOption = { key: string; label: string; detail?: string | null; swatch?: string | null };
export type RuleInput = {
  whenGroup: string;
  whenOption: string;
  effect: "EXCLUDES" | "REQUIRES";
  thenGroup: string;
  thenOptions: string[];
  message: string;
};
export type NewSlot = { label: string; printArea: string; bleedMm?: string | null; safeMm?: string | null };

const productPath = (slug: string) => `/products/${slug}`;
const categoryPath = (slug: string) => `/category/${slug}`;
const slotKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "slot";

/** Replaces a slug in content JSON: in `productSlugs` / `categorySlugs` lists and in links to its page. */
export function rewriteSlug(
  value: unknown,
  listKey: string,
  from: string,
  to: string,
  fromPath: string,
  toPath: string,
) {
  let changes = 0;
  const walk = (node: unknown, key?: string): unknown => {
    if (Array.isArray(node)) {
      if (key === listKey)
        return node.map((item) => {
          if (item === from) {
            changes++;
            return to;
          }
          return item;
        });
      return node.map((item) => walk(item));
    }
    if (node && typeof node === "object")
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    if (
      typeof node === "string" &&
      (node === fromPath || node.startsWith(`${fromPath}?`) || node.startsWith(`${fromPath}#`))
    ) {
      changes++;
      return toPath + node.slice(fromPath.length);
    }
    return node;
  };
  const result = walk(value);
  return { result, changes };
}

/**
 * Catalogue structure (AD-CAT-03/04/05): new products, option groups and options, constraint
 * rules, artwork slots and slug changes. Keys are permanent once created because pricing
 * documents, rules and (later) order snapshots refer to them.
 */
@Injectable()
export class CatalogueStructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: CatalogueAdminService,
  ) {}

  private record(
    actor: StaffContext,
    ctx: AuditContext,
    action: string,
    target: { type: string; id: string },
    change: { before?: unknown; after?: unknown },
    tx: Prisma.TransactionClient,
  ) {
    return this.audit.record({ ...ctx, actorId: actor.user.id }, action, target, change, tx);
  }

  taxProfiles() {
    return this.prisma.taxProfile
      .findMany({ orderBy: { name: "asc" } })
      .then((rows) => rows.map((r) => ({ id: r.id, name: r.name, gstRate: r.gstRate.toFixed(2), note: r.note })));
  }

  // ---------- products ----------

  async createProduct(actor: StaffContext, input: NewProduct, ctx: AuditContext) {
    if (await this.prisma.product.findUnique({ where: { slug: input.slug } }))
      throw new ProblemException(409, "SLUG_TAKEN", "That URL slug is already used", `"${input.slug}" is taken.`);
    if (!(await this.prisma.category.findUnique({ where: { id: input.categoryId } })))
      throw new ProblemException(422, "CATEGORY_UNKNOWN", "Choose an existing category");
    if (!(await this.prisma.taxProfile.findUnique({ where: { id: input.taxProfileId } })))
      throw new ProblemException(422, "TAX_PROFILE_UNKNOWN", "Choose a tax profile");
    if (input.turnaroundMinDays > input.turnaroundMaxDays)
      throw new ProblemException(422, "TURNAROUND_INVALID", "Turnaround: the minimum days can't exceed the maximum");
    if (input.quantityMode === "SIZES" && !input.sizes?.length)
      throw new ProblemException(422, "SIZES_REQUIRED", "List the sizes for a size-breakdown product");
    const last = await this.prisma.product.aggregate({ _max: { sort: true } });
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          slug: input.slug,
          name: input.name,
          categoryId: input.categoryId,
          summary: input.summary,
          lead: "",
          description: "",
          imageUrl: "",
          sort: (last._max.sort ?? -1) + 1,
          // Hidden until it has an image, an artwork slot and published pricing.
          isVisible: false,
          unitOne: input.unitOne,
          unitMany: input.unitMany,
          turnaroundMinDays: input.turnaroundMinDays,
          turnaroundMaxDays: input.turnaroundMaxDays,
          quantityMode: input.quantityMode,
          sizes: input.quantityMode === "SIZES" ? (input.sizes ?? []) : [],
          taxProfileId: input.taxProfileId,
        },
      });
      await this.record(
        actor,
        ctx,
        "catalogue.product_created",
        { type: "product", id: created.id },
        { after: { slug: created.slug, name: created.name } },
        tx,
      );
      return created.id;
    }, TX);
    return this.admin.getProduct(id);
  }

  // ---------- slug changes ----------

  async changeProductSlug(actor: StaffContext, id: string, slug: string, ctx: AuditContext) {
    const row = await this.prisma.product.findUnique({ where: { id } });
    if (!row) throw notFound("Product");
    if (row.slug === slug) return this.admin.getProduct(id);
    if (await this.prisma.product.findUnique({ where: { slug } }))
      throw new ProblemException(409, "SLUG_TAKEN", "That URL slug is already used", `"${slug}" is taken.`);
    const summary = await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { slug } });
      const moved = await this.moveReferences(
        tx,
        actor.user.id,
        "productSlugs",
        row.slug,
        slug,
        productPath(row.slug),
        productPath(slug),
      );
      await this.record(
        actor,
        ctx,
        "catalogue.product_slug_changed",
        { type: "product", id },
        { before: { slug: row.slug }, after: { slug, ...moved } },
        tx,
      );
      return moved;
    }, TX);
    return { ...(await this.admin.getProduct(id)), slugChange: summary };
  }

  async changeCategorySlug(actor: StaffContext, id: string, slug: string, ctx: AuditContext) {
    const row = await this.prisma.category.findUnique({ where: { id } });
    if (!row) throw notFound("Category");
    if (row.slug !== slug) {
      if (await this.prisma.category.findUnique({ where: { slug } }))
        throw new ProblemException(409, "SLUG_TAKEN", "That URL slug is already used", `"${slug}" is taken.`);
      await this.prisma.$transaction(async (tx) => {
        await tx.category.update({ where: { id }, data: { slug } });
        const moved = await this.moveReferences(
          tx,
          actor.user.id,
          "categorySlugs",
          row.slug,
          slug,
          categoryPath(row.slug),
          categoryPath(slug),
        );
        await this.record(
          actor,
          ctx,
          "catalogue.category_slug_changed",
          { type: "category", id },
          { before: { slug: row.slug }, after: { slug, ...moved } },
          tx,
        );
      }, TX);
    }
    return (await this.admin.listCategories()).find((c) => c.id === id);
  }

  /**
   * Keeps the site working after a slug change: a permanent redirect from the old address,
   * existing redirects re-pointed (no chains), and website content (draft and live) updated.
   */
  private async moveReferences(
    tx: Prisma.TransactionClient,
    actorId: string,
    listKey: string,
    from: string,
    to: string,
    fromPath: string,
    toPath: string,
  ) {
    await tx.redirect.deleteMany({ where: { fromPath: toPath } });
    const repointed = await tx.redirect.updateMany({ where: { toPath: fromPath }, data: { toPath } });
    await tx.redirect.upsert({
      where: { fromPath },
      update: { toPath, permanent: true },
      create: { fromPath, toPath, permanent: true },
    });

    let contentChanges = 0;
    const republished: string[] = [];
    const versions = await tx.contentPageVersion.findMany({ where: { status: { in: ["DRAFT", "PUBLISHED"] } } });
    for (const version of versions) {
      const { result, changes } = rewriteSlug(version.document, listKey, from, to, fromPath, toPath);
      if (!changes) continue;
      contentChanges += changes;
      if (version.status === "DRAFT") {
        await tx.contentPageVersion.update({
          where: { id: version.id },
          data: { document: result as Prisma.InputJsonValue },
        });
        continue;
      }
      // Live versions are immutable: archive it and publish an identical copy with the new address.
      const last = await tx.contentPageVersion.aggregate({
        where: { pageId: version.pageId },
        _max: { versionNo: true },
      });
      await tx.contentPageVersion.update({ where: { id: version.id }, data: { status: "ARCHIVED" } });
      const copy = await tx.contentPageVersion.create({
        data: {
          pageId: version.pageId,
          versionNo: (last._max.versionNo ?? 0) + 1,
          status: "PUBLISHED",
          document: result as Prisma.InputJsonValue,
          createdById: actorId,
          publishedById: actorId,
          publishedAt: new Date(),
        },
      });
      republished.push(copy.id);
    }
    const menus = await tx.navigationMenu.findMany();
    for (const menu of menus) {
      const draft = rewriteSlug(menu.draft, listKey, from, to, fromPath, toPath);
      const published = menu.published ? rewriteSlug(menu.published, listKey, from, to, fromPath, toPath) : null;
      if (draft.changes || published?.changes) {
        contentChanges += draft.changes + (published?.changes ?? 0);
        await tx.navigationMenu.update({
          where: { id: menu.id },
          data: {
            draft: draft.result as Prisma.InputJsonValue,
            ...(published ? { published: published.result as Prisma.InputJsonValue } : {}),
          },
        });
      }
    }
    const settings = await tx.siteSettings.findMany();
    for (const row of settings) {
      const draft = rewriteSlug(row.draft, listKey, from, to, fromPath, toPath);
      const published = row.published ? rewriteSlug(row.published, listKey, from, to, fromPath, toPath) : null;
      if (draft.changes || published?.changes) {
        contentChanges += draft.changes + (published?.changes ?? 0);
        await tx.siteSettings.update({
          where: { id: row.id },
          data: {
            draft: draft.result as Prisma.InputJsonValue,
            ...(published ? { published: published.result as Prisma.InputJsonValue } : {}),
          },
        });
      }
    }
    return {
      redirect: { fromPath, toPath },
      redirectsRepointed: repointed.count,
      contentReferencesUpdated: contentChanges,
      pagesRepublished: republished.length,
    };
  }

  // ---------- option groups ----------

  /** Pricing documents still in use (draft, scheduled or live) and rules, for "is this key used?" checks. */
  private async usage(productId: string) {
    const versions = await this.prisma.pricingVersion.findMany({
      where: { productId, status: { in: ["DRAFT", "SCHEDULED", "PUBLISHED"] } },
    });
    const docs = versions.map((v) => ({
      versionNo: v.versionNo,
      status: v.status,
      doc: parsePricingDocument(v.document),
    }));
    const rules = await this.prisma.optionRule.findMany({ where: { productId } });
    return { docs, rules };
  }

  private async groupOf(groupId: string) {
    const group = await this.prisma.optionGroup.findUnique({ where: { id: groupId }, include: { options: true } });
    if (!group) throw notFound("Option group");
    return group;
  }

  async addGroup(actor: StaffContext, productId: string, input: NewGroup, ctx: AuditContext) {
    if (!(await this.prisma.product.findUnique({ where: { id: productId } }))) throw notFound("Product");
    if (await this.prisma.optionGroup.findUnique({ where: { productId_key: { productId, key: input.key } } }))
      throw new ProblemException(409, "KEY_TAKEN", "This product already has an option group with that key");
    const last = await this.prisma.optionGroup.aggregate({ where: { productId }, _max: { stepOrder: true } });
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.optionGroup.create({
        data: {
          productId,
          key: input.key,
          label: input.label,
          shortLabel: input.shortLabel ?? null,
          hint: input.hint,
          kind: input.kind,
          required: input.required,
          stepOrder: (last._max.stepOrder ?? -1) + 1,
          defaultKeys: [],
        },
      });
      await this.record(
        actor,
        ctx,
        "catalogue.option_group_created",
        { type: "option_group", id: created.id },
        { after: input },
        tx,
      );
    }, TX);
    return this.admin.getProduct(productId);
  }

  async updateGroup(actor: StaffContext, groupId: string, patch: GroupPatch, ctx: AuditContext) {
    const group = await this.groupOf(groupId);
    if (patch.defaultKeys) {
      const keys = new Set(group.options.map((o) => o.key));
      const unknown = patch.defaultKeys.filter((k) => !keys.has(k));
      if (unknown.length)
        throw new ProblemException(422, "OPTION_UNKNOWN", "Defaults must be options of this group", unknown.join(", "));
      if (group.kind !== "MULTISELECT" && patch.defaultKeys.length > 1)
        throw new ProblemException(422, "DEFAULTS_INVALID", "A pick-one group has a single default");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.optionGroup.update({ where: { id: groupId }, data: patch });
      await this.record(
        actor,
        ctx,
        "catalogue.option_group_updated",
        { type: "option_group", id: groupId },
        {
          before: Object.fromEntries(Object.keys(patch).map((k) => [k, group[k as keyof typeof group]])),
          after: patch,
        },
        tx,
      );
    }, TX);
    return this.admin.getProduct(group.productId);
  }

  async reorderGroups(actor: StaffContext, productId: string, ids: string[], ctx: AuditContext) {
    const groups = await this.prisma.optionGroup.findMany({ where: { productId }, orderBy: { stepOrder: "asc" } });
    const known = new Set(groups.map((g) => g.id));
    if (ids.length !== groups.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
      throw new ProblemException(422, "ORDER_INVALID", "Send every option group of this product exactly once");
    await this.prisma.$transaction(async (tx) => {
      for (const [stepOrder, id] of ids.entries()) await tx.optionGroup.update({ where: { id }, data: { stepOrder } });
      await this.record(
        actor,
        ctx,
        "catalogue.option_groups_reordered",
        { type: "product", id: productId },
        { before: groups.map((g) => g.key), after: ids.map((id) => groups.find((g) => g.id === id)!.key) },
        tx,
      );
    }, TX);
    return this.admin.getProduct(productId);
  }

  async deleteGroup(actor: StaffContext, groupId: string, ctx: AuditContext) {
    const group = await this.groupOf(groupId);
    const { docs, rules } = await this.usage(group.productId);
    const problems: string[] = [];
    for (const { versionNo, status, doc } of docs) {
      if (doc.options[group.key]) problems.push(`v${versionNo} (${status.toLowerCase()}) prices options of this group`);
      if (doc.setupCharges.some((c) => c.group === group.key || c.appliesWhen.group === group.key))
        problems.push(`v${versionNo} (${status.toLowerCase()}) has a setup charge on this group`);
    }
    for (const rule of rules)
      if (rule.whenGroup === group.key || rule.thenGroup === group.key) problems.push(`Rule: “${rule.message}”`);
    if (problems.length)
      throw new ProblemException(409, "IN_USE", "This option group is still in use", undefined, { problems });
    await this.prisma.$transaction(async (tx) => {
      await tx.optionGroup.delete({ where: { id: groupId } });
      await this.record(
        actor,
        ctx,
        "catalogue.option_group_deleted",
        { type: "option_group", id: groupId },
        { before: { key: group.key, label: group.label, options: group.options.map((o) => o.key) } },
        tx,
      );
    }, TX);
    return this.admin.getProduct(group.productId);
  }

  // ---------- options ----------

  async addOption(actor: StaffContext, groupId: string, input: NewOption, ctx: AuditContext) {
    const group = await this.groupOf(groupId);
    if (group.options.some((o) => o.key === input.key))
      throw new ProblemException(409, "KEY_TAKEN", "This group already has an option with that key");
    const sort = Math.max(-1, ...group.options.map((o) => o.sort)) + 1;
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.option.create({
        data: {
          groupId,
          key: input.key,
          label: input.label,
          detail: input.detail ?? null,
          swatch: input.swatch ?? null,
          sort,
        },
      });
      // The first option of a pick-one group becomes its default.
      if (group.kind !== "MULTISELECT" && !group.defaultKeys.length)
        await tx.optionGroup.update({ where: { id: groupId }, data: { defaultKeys: [input.key] } });
      await this.record(
        actor,
        ctx,
        "catalogue.option_created",
        { type: "option", id: created.id },
        { after: { group: group.key, ...input } },
        tx,
      );
    }, TX);
    return this.admin.getProduct(group.productId);
  }

  async deleteOption(actor: StaffContext, optionId: string, ctx: AuditContext) {
    const option = await this.prisma.option.findUnique({
      where: { id: optionId },
      include: { group: { include: { options: true } } },
    });
    if (!option) throw notFound("Option");
    const group = option.group;
    if (group.options.length === 1)
      throw new ProblemException(409, "LAST_OPTION", "A group needs at least one option", "Delete the group instead.");
    const { docs, rules } = await this.usage(group.productId);
    const problems: string[] = [];
    for (const { versionNo, status, doc } of docs) {
      if (doc.options[group.key]?.[option.key])
        problems.push(`v${versionNo} (${status.toLowerCase()}) prices this option`);
      if (doc.setupCharges.some((c) => c.appliesWhen.group === group.key && c.appliesWhen.option === option.key))
        problems.push(`v${versionNo} (${status.toLowerCase()}) has a setup charge on this option`);
    }
    for (const rule of rules)
      if (
        (rule.whenGroup === group.key && rule.whenOption === option.key) ||
        (rule.thenGroup === group.key && rule.thenOptions.includes(option.key))
      )
        problems.push(`Rule: “${rule.message}”`);
    if (problems.length)
      throw new ProblemException(409, "IN_USE", "This option is still in use", "Or mark it as not orderable instead.", {
        problems,
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.option.delete({ where: { id: optionId } });
      if (group.defaultKeys.includes(option.key))
        await tx.optionGroup.update({
          where: { id: group.id },
          data: { defaultKeys: group.defaultKeys.filter((k) => k !== option.key) },
        });
      await this.record(
        actor,
        ctx,
        "catalogue.option_deleted",
        { type: "option", id: optionId },
        { before: { group: group.key, key: option.key, label: option.label } },
        tx,
      );
    }, TX);
    return this.admin.getProduct(group.productId);
  }

  async reorderOptions(actor: StaffContext, groupId: string, ids: string[], ctx: AuditContext) {
    const group = await this.groupOf(groupId);
    const known = new Set(group.options.map((o) => o.id));
    if (ids.length !== group.options.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
      throw new ProblemException(422, "ORDER_INVALID", "Send every option of this group exactly once");
    await this.prisma.$transaction(async (tx) => {
      for (const [sort, id] of ids.entries()) await tx.option.update({ where: { id }, data: { sort } });
      await this.record(
        actor,
        ctx,
        "catalogue.options_reordered",
        { type: "option_group", id: groupId },
        { after: ids },
        tx,
      );
    }, TX);
    return this.admin.getProduct(group.productId);
  }

  // ---------- constraint rules ----------

  private async checkRule(productId: string, input: RuleInput) {
    const groups = await this.prisma.optionGroup.findMany({ where: { productId }, include: { options: true } });
    const when = groups.find((g) => g.key === input.whenGroup);
    const then = groups.find((g) => g.key === input.thenGroup);
    const problems: string[] = [];
    if (!when) problems.push(`Unknown group "${input.whenGroup}"`);
    else if (!when.options.some((o) => o.key === input.whenOption))
      problems.push(`"${input.whenOption}" is not an option of ${when.label}`);
    if (!then) problems.push(`Unknown group "${input.thenGroup}"`);
    else
      for (const key of input.thenOptions)
        if (!then.options.some((o) => o.key === key)) problems.push(`"${key}" is not an option of ${then.label}`);
    if (input.whenGroup === input.thenGroup) problems.push("A rule links two different option groups");
    if (problems.length)
      throw new ProblemException(422, "RULE_INVALID", "This rule doesn't match the product", undefined, { problems });
  }

  async addRule(actor: StaffContext, productId: string, input: RuleInput, ctx: AuditContext) {
    if (!(await this.prisma.product.findUnique({ where: { id: productId } }))) throw notFound("Product");
    await this.checkRule(productId, input);
    const last = await this.prisma.optionRule.aggregate({ where: { productId }, _max: { sort: true } });
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.optionRule.create({ data: { productId, ...input, sort: (last._max.sort ?? -1) + 1 } });
      await this.record(
        actor,
        ctx,
        "catalogue.rule_created",
        { type: "option_rule", id: created.id },
        { after: input },
        tx,
      );
    }, TX);
    return this.admin.getProduct(productId);
  }

  async updateRule(actor: StaffContext, ruleId: string, input: RuleInput, ctx: AuditContext) {
    const rule = await this.prisma.optionRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw notFound("Rule");
    await this.checkRule(rule.productId, input);
    await this.prisma.$transaction(async (tx) => {
      await tx.optionRule.update({ where: { id: ruleId }, data: input });
      await this.record(
        actor,
        ctx,
        "catalogue.rule_updated",
        { type: "option_rule", id: ruleId },
        {
          before: {
            whenGroup: rule.whenGroup,
            whenOption: rule.whenOption,
            effect: rule.effect,
            thenGroup: rule.thenGroup,
            thenOptions: rule.thenOptions,
            message: rule.message,
          },
          after: input,
        },
        tx,
      );
    }, TX);
    return this.admin.getProduct(rule.productId);
  }

  async deleteRule(actor: StaffContext, ruleId: string, ctx: AuditContext) {
    const rule = await this.prisma.optionRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw notFound("Rule");
    await this.prisma.$transaction(async (tx) => {
      await tx.optionRule.delete({ where: { id: ruleId } });
      await this.record(
        actor,
        ctx,
        "catalogue.rule_deleted",
        { type: "option_rule", id: ruleId },
        { before: { message: rule.message } },
        tx,
      );
    }, TX);
    return this.admin.getProduct(rule.productId);
  }

  // ---------- artwork slots ----------

  async addSlot(actor: StaffContext, productId: string, input: NewSlot, ctx: AuditContext) {
    const slots = await this.prisma.artworkSlot.findMany({ where: { productId } });
    if (!(await this.prisma.product.findUnique({ where: { id: productId } }))) throw notFound("Product");
    let key = slotKey(input.label);
    for (let n = 2; slots.some((s) => s.key === key); n++) key = `${slotKey(input.label)}-${n}`;
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.artworkSlot.create({
        data: {
          productId,
          key,
          label: input.label,
          printArea: input.printArea,
          bleedMm: input.bleedMm ?? null,
          safeMm: input.safeMm ?? null,
          sort: Math.max(-1, ...slots.map((s) => s.sort)) + 1,
        },
      });
      await this.record(
        actor,
        ctx,
        "catalogue.artwork_slot_created",
        { type: "artwork_slot", id: created.id },
        { after: { key, ...input } },
        tx,
      );
    }, TX);
    return this.admin.getProduct(productId);
  }

  async deleteSlot(actor: StaffContext, slotId: string, ctx: AuditContext) {
    const slot = await this.prisma.artworkSlot.findUnique({ where: { id: slotId }, include: { product: true } });
    if (!slot) throw notFound("Artwork slot");
    const count = await this.prisma.artworkSlot.count({ where: { productId: slot.productId } });
    if (count === 1 && slot.product.isVisible)
      throw new ProblemException(409, "LAST_SLOT", "A product on the site needs at least one artwork slot");
    await this.prisma.$transaction(async (tx) => {
      await tx.artworkSlot.delete({ where: { id: slotId } });
      await this.record(
        actor,
        ctx,
        "catalogue.artwork_slot_deleted",
        { type: "artwork_slot", id: slotId },
        { before: { key: slot.key, label: slot.label } },
        tx,
      );
    }, TX);
    return this.admin.getProduct(slot.productId);
  }
}
