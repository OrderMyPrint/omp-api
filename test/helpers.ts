import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { expect } from "vitest";
import { randomToken, sha256, totp } from "../src/auth/crypto";

export const PASSWORD = "correct horse battery staple";
export type Signed = {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  secret: string;
  userId: string;
  email: string;
};

/** Invites a staff member with a role, accepts, enrols TOTP — returns a signed-in agent. */
export async function signedInStaff(
  http: Parameters<typeof request.agent>[0],
  prisma: PrismaClient,
  roleKey: string,
  label: string,
): Promise<Signed> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const email = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const user = await prisma.user.create({
    data: { kind: "STAFF", email, name: label, staffStatus: "INVITED", roleId: role.id },
  });
  const token = randomToken();
  await prisma.staffInvitation.create({
    data: { tokenHash: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  const agent = request.agent(http);
  const accepted = await agent
    .post("/api/v1/admin/auth/invitations/accept")
    .send({ token, password: PASSWORD })
    .expect(200);
  const secret = accepted.body.totpSecret as string;
  const done = await agent
    .post("/api/v1/admin/auth/totp")
    .set("x-csrf-token", accepted.body.csrfToken)
    .send({ code: totp(secret) })
    .expect(200);
  expect(done.body.signedIn).toBe(true);
  return { agent, csrf: done.body.csrfToken, secret, userId: user.id, email };
}

/** A code for the next 30 s window, so it isn't rejected as a replay of the last one. */
export const nextCode = (secret: string) => totp(secret, Date.now() + 30_000);
