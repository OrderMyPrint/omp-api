/**
 * Permission registry — the single source of truth for staff permission keys.
 * Matches the role editor in Figma (AD-STF-02) and docs repo
 * docs/design/admin-audit-2026-11-05.md. Keys are `module.action`.
 */

export type PermissionDef = { key: string; module: string; label: string };

export const PERMISSIONS: PermissionDef[] = [
  { key: "dashboard.read", module: "Dashboard", label: "View the dashboard" },
  { key: "catalogue.read", module: "Catalogue", label: "View products & categories" },
  { key: "catalogue.write", module: "Catalogue", label: "Edit products & categories" },
  { key: "catalogue.publish", module: "Catalogue", label: "Show / hide products" },
  { key: "pricing.read", module: "Pricing", label: "View pricing" },
  { key: "pricing.write", module: "Pricing", label: "Edit draft pricing" },
  { key: "pricing.publish", module: "Pricing", label: "Publish pricing versions" },
  { key: "content.read", module: "Website content", label: "View pages" },
  { key: "content.write", module: "Website content", label: "Edit pages & FAQ" },
  { key: "content.publish", module: "Website content", label: "Publish to the live site" },
  { key: "media.write", module: "Website content", label: "Upload & replace media" },
  { key: "navigation.write", module: "Website content", label: "Edit menus" },
  { key: "site_settings.write", module: "Website content", label: "Brand, contact, redirects" },
  { key: "orders.read", module: "Orders", label: "View orders" },
  { key: "orders.write", module: "Orders", label: "Update orders" },
  { key: "orders.cancel", module: "Orders", label: "Cancel orders" },
  { key: "quotes.read", module: "Quotations", label: "View quotations" },
  { key: "quotes.write", module: "Quotations", label: "Prepare & send quotations" },
  { key: "quotes.override_price", module: "Quotations", label: "Override quote prices" },
  { key: "artwork.read", module: "Artwork", label: "View artwork" },
  { key: "artwork.review", module: "Artwork", label: "Approve or reject artwork" },
  { key: "production.read", module: "Production & QC", label: "View production" },
  { key: "production.write", module: "Production & QC", label: "Update production jobs" },
  { key: "qc.write", module: "Production & QC", label: "Record quality checks" },
  { key: "shipments.read", module: "Shipping", label: "View shipments" },
  { key: "shipments.write", module: "Shipping", label: "Create & update shipments" },
  { key: "customers.read", module: "Customers", label: "View customers & companies" },
  { key: "customers.write", module: "Customers", label: "Edit customers & companies" },
  { key: "credit_terms.approve", module: "Customers", label: "Approve credit terms" },
  { key: "payments.read", module: "Payments & invoices", label: "View payments" },
  { key: "refunds.request", module: "Payments & invoices", label: "Request refunds" },
  { key: "refunds.approve", module: "Payments & invoices", label: "Approve refunds" },
  { key: "invoices.read", module: "Payments & invoices", label: "View invoices" },
  { key: "coupons.read", module: "Coupons", label: "View coupons" },
  { key: "coupons.write", module: "Coupons", label: "Create & edit coupons" },
  { key: "reports.read", module: "Reports", label: "View reports" },
  { key: "staff.read", module: "Staff & roles", label: "View staff" },
  { key: "staff.manage", module: "Staff & roles", label: "Invite & manage staff" },
  { key: "roles.manage", module: "Staff & roles", label: "Create & edit roles" },
  { key: "settings.write", module: "Settings & audit", label: "Edit business settings" },
  { key: "audit.read", module: "Settings & audit", label: "View the audit log" },
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));
export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);

export const OWNER_ROLE_KEY = "owner";

const all = (...prefixes: string[]) => ALL_PERMISSIONS.filter((k) => prefixes.some((p) => k.startsWith(p)));

/** Default roles. Owner is a locked system role; the others are editable starting points. */
export const DEFAULT_ROLES: {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
}[] = [
  {
    key: OWNER_ROLE_KEY,
    name: "Owner",
    description: "Every permission. Cannot be edited or deleted; at least one active Owner is always required.",
    isSystem: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "admin",
    name: "Admin",
    description: "Everything except managing roles and approving refunds.",
    isSystem: false,
    permissions: ALL_PERMISSIONS.filter((k) => k !== "roles.manage" && k !== "refunds.approve"),
  },
  {
    key: "content-editor",
    name: "Content editor",
    description: "Edits website pages, menus, media, FAQ and catalogue text.",
    isSystem: false,
    permissions: [
      "dashboard.read",
      "content.read",
      "content.write",
      "content.publish",
      "media.write",
      "navigation.write",
      "catalogue.read",
      "catalogue.write",
      "pricing.read",
    ],
  },
  {
    key: "sales",
    name: "Sales",
    description: "Quotations, customers and orders.",
    isSystem: false,
    permissions: [
      "dashboard.read",
      "catalogue.read",
      "pricing.read",
      "orders.read",
      ...all("quotes."),
      "customers.read",
      "customers.write",
    ],
  },
  {
    key: "pre-press",
    name: "Pre-press",
    description: "Reviews and approves artwork.",
    isSystem: false,
    permissions: ["dashboard.read", "orders.read", "artwork.read", "artwork.review", "catalogue.read"],
  },
  {
    key: "production",
    name: "Production",
    description: "Production jobs, quality checks and shipping.",
    isSystem: false,
    permissions: ["dashboard.read", "orders.read", "artwork.read", ...all("production.", "qc.", "shipments.")],
  },
  {
    key: "finance",
    name: "Finance",
    description: "Payments, refunds, invoices and credit terms.",
    isSystem: false,
    permissions: [
      "dashboard.read",
      "orders.read",
      "customers.read",
      "credit_terms.approve",
      ...all("payments.", "refunds.", "invoices."),
      "reports.read",
    ],
  },
];

export function invalidPermissions(keys: string[]): string[] {
  return keys.filter((k) => !PERMISSION_KEYS.has(k));
}
