import { Injectable } from "@nestjs/common";
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import { AuditService, type AuditContext } from "../auth/audit.service";
import type { StaffContext } from "../auth/auth.service";
import { normalisePhone } from "../commerce/customer-auth";
import { ProblemException } from "../common/problem";
import { PrismaService } from "../prisma/prisma.service";

const money = (d: Prisma.Decimal | Decimal | string | number) => new Decimal(d.toString()).toFixed(2);
/** Orders that count towards lifetime value: paid and not cancelled. */
const COUNTED: Prisma.OrderWhereInput = { paidAt: { not: null }, status: { not: "CANCELLED" } };
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** AD-CUS-01/02 · Customers (mobile + OTP accounts) and company accounts. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q?: string) {
    const term = q?.trim();
    const digits = term?.replace(/\D/g, "");
    const rows = await this.prisma.user.findMany({
      where: {
        kind: "CUSTOMER",
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: "insensitive" } },
                { email: { contains: term.toLowerCase() } },
                ...(digits && digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : []),
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { companies: { include: { company: { select: { id: true, name: true } } } } },
    });
    const stats = await this.prisma.order.groupBy({
      by: ["userId"],
      where: { userId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const lifetime = await this.prisma.order.groupBy({
      by: ["userId"],
      where: { userId: { in: rows.map((r) => r.id) }, ...COUNTED },
      _sum: { grandTotal: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phoneE164,
      email: r.email,
      companies: r.companies.map((m) => ({ id: m.company.id, name: m.company.name, role: m.role })),
      orders: stats.find((s) => s.userId === r.id)?._count._all ?? 0,
      lifetimeValue: money(lifetime.find((s) => s.userId === r.id)?._sum.grandTotal ?? 0),
      joinedAt: r.createdAt,
    }));
  }

  async customer(id: string) {
    const r = await this.prisma.user.findFirst({
      where: { id, kind: "CUSTOMER" },
      include: {
        companies: { include: { company: { select: { id: true, name: true } } } },
        orders: { orderBy: { placedAt: "desc" }, take: 50 },
        quotesAsCustomer: { orderBy: { createdAt: "desc" }, take: 50 },
      },
    });
    if (!r) throw new ProblemException(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    const counted = r.orders.filter((o) => o.paidAt && o.status !== "CANCELLED");
    return {
      id: r.id,
      name: r.name,
      phone: r.phoneE164,
      email: r.email,
      joinedAt: r.createdAt,
      lastActiveAt: r.lastActiveAt,
      companies: r.companies.map((m) => ({ id: m.company.id, name: m.company.name, role: m.role })),
      lifetimeValue: money(counted.reduce((sum, o) => sum.plus(o.grandTotal.toString()), new Decimal(0))),
      orders: r.orders.map((o) => ({
        id: o.id,
        number: o.orderNumber,
        status: o.status,
        total: money(o.grandTotal),
        placedAt: o.placedAt,
      })),
      quotes: r.quotesAsCustomer.map((q) => ({
        id: q.id,
        number: q.number,
        status: q.status,
        total: money(q.grandTotal),
        createdAt: q.createdAt,
      })),
    };
  }

  async updateCustomer(
    actor: StaffContext,
    id: string,
    input: { name?: string; email?: string | null },
    ctx: AuditContext,
  ) {
    const before = await this.prisma.user.findFirst({ where: { id, kind: "CUSTOMER" } });
    if (!before) throw new ProblemException(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    const email = input.email === undefined ? undefined : input.email ? input.email.trim().toLowerCase() : null;
    if (email && (await this.prisma.user.findFirst({ where: { email, id: { not: id } } })))
      throw new ProblemException(409, "EMAIL_IN_USE", "Another account uses this email");
    await this.prisma.user.update({ where: { id }, data: { name: input.name, email } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "customer.updated",
      { type: "user", id },
      { before: { name: before.name, email: before.email }, after: input },
    );
    return this.customer(id);
  }

  // ------------------------------------------------------------ companies

  async companies(q?: string) {
    const rows = await this.prisma.company.findMany({
      where: q?.trim()
        ? {
            OR: [
              { name: { contains: q.trim(), mode: "insensitive" } },
              { gstin: { contains: q.trim().toUpperCase() } },
            ],
          }
        : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { members: true, quotes: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      gstin: c.gstin,
      members: c._count.members,
      quotes: c._count.quotes,
      creditEnabled: c.creditEnabled,
      creditTermsDays: c.creditTermsDays,
    }));
  }

  async company(id: string) {
    const c = await this.prisma.company.findUnique({
      where: { id },
      include: {
        members: { include: { user: true }, orderBy: { createdAt: "asc" } },
        quotes: { orderBy: { createdAt: "desc" }, take: 50 },
      },
    });
    if (!c) throw new ProblemException(404, "COMPANY_NOT_FOUND", "Company not found");
    const memberIds = c.members.map((m) => m.userId);
    const orders = await this.prisma.order.findMany({
      where: { userId: { in: memberIds } },
      orderBy: { placedAt: "desc" },
      take: 50,
    });
    const approver = c.creditApprovedById
      ? await this.prisma.user.findUnique({ where: { id: c.creditApprovedById }, select: { name: true } })
      : null;
    return {
      id: c.id,
      name: c.name,
      gstin: c.gstin,
      notes: c.notes,
      credit: {
        enabled: c.creditEnabled,
        termsDays: c.creditTermsDays,
        approvedBy: approver?.name ?? null,
        approvedAt: c.creditApprovedAt,
      },
      members: c.members.map((m) => ({ id: m.userId, name: m.user.name, phone: m.user.phoneE164, role: m.role })),
      orders: orders.map((o) => ({
        id: o.id,
        number: o.orderNumber,
        status: o.status,
        total: money(o.grandTotal),
        placedAt: o.placedAt,
      })),
      lifetimeValue: money(
        orders
          .filter((o) => o.paidAt && o.status !== "CANCELLED")
          .reduce((s, o) => s.plus(o.grandTotal.toString()), new Decimal(0)),
      ),
      quotes: c.quotes.map((q) => ({ id: q.id, number: q.number, status: q.status, total: money(q.grandTotal) })),
    };
  }

  private gstin(value: string | null | undefined) {
    if (value === undefined) return undefined;
    const g = value?.trim().toUpperCase() || null;
    if (g && !GSTIN.test(g))
      throw new ProblemException(400, "GSTIN_INVALID", "Check the GSTIN", "15 characters, e.g. 27ABCDE1234F1Z5");
    return g;
  }

  async createCompany(
    actor: StaffContext,
    input: { name: string; gstin?: string | null; notes?: string | null },
    ctx: AuditContext,
  ) {
    const gstin = this.gstin(input.gstin);
    if (gstin && (await this.prisma.company.findUnique({ where: { gstin } })))
      throw new ProblemException(409, "COMPANY_EXISTS", "A company with this GSTIN already exists");
    const c = await this.prisma.company.create({ data: { name: input.name, gstin, notes: input.notes ?? null } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "company.created",
      { type: "company", id: c.id },
      { after: { name: c.name, gstin } },
    );
    return this.company(c.id);
  }

  async updateCompany(
    actor: StaffContext,
    id: string,
    input: { name?: string; gstin?: string | null; notes?: string | null },
    ctx: AuditContext,
  ) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw new ProblemException(404, "COMPANY_NOT_FOUND", "Company not found");
    const gstin = this.gstin(input.gstin);
    if (gstin && (await this.prisma.company.findFirst({ where: { gstin, id: { not: id } } })))
      throw new ProblemException(409, "COMPANY_EXISTS", "A company with this GSTIN already exists");
    await this.prisma.company.update({ where: { id }, data: { name: input.name, gstin, notes: input.notes } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "company.updated",
      { type: "company", id },
      { before: { name: before.name, gstin: before.gstin }, after: input },
    );
    return this.company(id);
  }

  /** Credit terms let a company's paid-later orders enter production (AD-CUS-02). Needs credit_terms.approve + step-up. */
  async setCredit(
    actor: StaffContext,
    id: string,
    input: { enabled: boolean; termsDays: number | null },
    ctx: AuditContext,
  ) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw new ProblemException(404, "COMPANY_NOT_FOUND", "Company not found");
    if (input.enabled && !input.termsDays)
      throw new ProblemException(400, "TERMS_REQUIRED", "Choose the payment terms (days)");
    await this.prisma.$transaction(async (tx) => {
      await tx.company.update({
        where: { id },
        data: {
          creditEnabled: input.enabled,
          creditTermsDays: input.enabled ? input.termsDays : null,
          creditApprovedById: input.enabled ? actor.user.id : null,
          creditApprovedAt: input.enabled ? new Date() : null,
        },
      });
      await this.audit.record(
        { ...ctx, actorId: actor.user.id },
        "company.credit_changed",
        { type: "company", id },
        { before: { enabled: before.creditEnabled, termsDays: before.creditTermsDays }, after: input },
        tx,
      );
    });
    return this.company(id);
  }

  /** Adds an existing customer (by mobile number) to the company. */
  async addMember(
    actor: StaffContext,
    id: string,
    input: { phone: string; role: "ADMIN" | "MEMBER" },
    ctx: AuditContext,
  ) {
    const phone = normalisePhone(input.phone);
    if (!phone) throw new ProblemException(400, "PHONE_INVALID", "Enter a 10-digit Indian mobile number");
    const user = await this.prisma.user.findFirst({ where: { phoneE164: phone, kind: "CUSTOMER" } });
    if (!user)
      throw new ProblemException(
        404,
        "CUSTOMER_NOT_FOUND",
        "No customer with this mobile number",
        "They need to sign in on the website once before they can be added.",
      );
    if (!(await this.prisma.company.findUnique({ where: { id } })))
      throw new ProblemException(404, "COMPANY_NOT_FOUND", "Company not found");
    await this.prisma.companyMember.upsert({
      where: { companyId_userId: { companyId: id, userId: user.id } },
      create: { companyId: id, userId: user.id, role: input.role },
      update: { role: input.role },
    });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "company.member_set",
      { type: "company", id },
      { after: { userId: user.id, role: input.role } },
    );
    return this.company(id);
  }

  async removeMember(actor: StaffContext, id: string, userId: string, ctx: AuditContext) {
    await this.prisma.companyMember.deleteMany({ where: { companyId: id, userId } });
    await this.audit.record(
      { ...ctx, actorId: actor.user.id },
      "company.member_removed",
      { type: "company", id },
      { before: { userId } },
    );
    return this.company(id);
  }
}
