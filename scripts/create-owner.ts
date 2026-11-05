/**
 * Bootstraps the first Owner account.
 *
 *   npm run admin:create-owner -- --email owner@company.com --name "Full Name"
 *
 * Creates the staff user as INVITED with the Owner role and prints a one-time
 * invitation link (valid 7 days). The person opens it, chooses a password and
 * sets up an authenticator app — no password ever passes through this script.
 * Refuses to run once an active Owner exists: further staff are invited from admin.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import { OWNER_ROLE_KEY } from "../src/auth/permissions";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || !name) {
    throw new Error('Usage: npm run admin:create-owner -- --email owner@company.com --name "Full Name"');
  }
  const owner = await prisma.role.findUnique({ where: { key: OWNER_ROLE_KEY } });
  if (!owner) throw new Error("Owner role missing — run `npm run db:seed` first.");
  const active = await prisma.user.count({ where: { kind: "STAFF", staffStatus: "ACTIVE", roleId: owner.id } });
  if (active > 0) throw new Error("An active Owner already exists. Invite more staff from the admin (Staff & roles).");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && (existing.kind !== "STAFF" || existing.staffStatus !== "INVITED"))
    throw new Error("This email already has an account.");
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { name, roleId: owner.id } })
    : await prisma.user.create({ data: { kind: "STAFF", email, name, staffStatus: "INVITED", roleId: owner.id } });

  const token = randomBytes(32).toString("base64url");
  const ttl = 7 * 24 * 60 * 60 * 1000;
  await prisma.staffInvitation.updateMany({
    where: { userId: user.id, acceptedAt: null },
    data: { expiresAt: new Date() },
  });
  await prisma.staffInvitation.create({
    data: {
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      expiresAt: new Date(Date.now() + ttl),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorKind: "system",
      action: "staff.owner_bootstrap",
      targetType: "user",
      targetId: user.id,
      after: { email },
    },
  });

  const base = (process.env.ADMIN_APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");
  console.log(`Owner invitation for ${email} (valid 7 days, single use):\n${base}/accept-invite#token=${token}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
