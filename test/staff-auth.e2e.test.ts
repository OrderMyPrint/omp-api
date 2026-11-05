import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken, sha256, totp } from "../src/auth/crypto";
import { createApp } from "../src/setup";

let app: INestApplication;
let http: ReturnType<INestApplication["getHttpServer"]>;
const prisma = new PrismaClient();
const run = Date.now().toString(36);
const PASSWORD = "correct horse battery staple";
const ADMIN_ORIGIN = "http://localhost:5173";

type Signed = { agent: ReturnType<typeof request.agent>; csrf: string; secret: string; userId: string; email: string };

/** Invite a staff member with a role, accept, enrol TOTP — returns a signed-in agent. */
async function signedInStaff(roleKey: string, label: string): Promise<Signed> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const email = `${label}-${run}@example.com`;
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
  expect(accepted.body.next).toBe("enroll");
  const secret = accepted.body.totpSecret as string;
  const done = await agent
    .post("/api/v1/admin/auth/totp")
    .set("x-csrf-token", accepted.body.csrfToken)
    .send({ code: totp(secret) })
    .expect(200);
  return { agent, csrf: done.body.csrfToken, secret, userId: user.id, email };
}

/** A code for the next 30 s window, so it isn't rejected as a replay of the last one. */
const nextCode = (secret: string) => totp(secret, Date.now() + 30_000);

async function stepUp(s: Signed) {
  await s.agent
    .post("/api/v1/admin/auth/step-up")
    .set("x-csrf-token", s.csrf)
    .send({ code: nextCode(s.secret) })
    .expect(200);
}

let owner: Signed;

beforeAll(async () => {
  app = await createApp();
  await app.init();
  http = app.getHttpServer();
  owner = await signedInStaff("owner", "owner");
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("sign-in", () => {
  it("gives the Owner every permission after invitation + authenticator enrolment", async () => {
    const me = await owner.agent.get("/api/v1/admin/auth/me").expect(200);
    expect(me.body).toMatchObject({
      email: owner.email,
      twoFactor: true,
      secondFactorPending: false,
      role: { key: "owner" },
    });
    expect(me.body.permissions).toContain("roles.manage");
    expect(me.body.permissions.length).toBeGreaterThan(35);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(user.staffStatus).toBe("ACTIVE");
    expect(user.totpSecretEnc).not.toContain(owner.secret); // encrypted at rest
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("requires the second factor after the password, and sets httpOnly cookies", async () => {
    const s = await signedInStaff("sales", "sales-login");
    await s.agent.post("/api/v1/admin/auth/logout").set("x-csrf-token", s.csrf).expect(200);
    const agent = request.agent(http);
    const login = await agent
      .post("/api/v1/admin/auth/login")
      .send({ email: s.email.toUpperCase(), password: PASSWORD })
      .expect(200);
    expect(login.body.next).toBe("totp");
    const cookies = ([] as string[]).concat(login.headers["set-cookie"] ?? []);
    expect(cookies.find((c) => c.startsWith("omp_staff_session="))).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith("omp_staff_session="))).toMatch(/SameSite=Lax/i);

    const pending = await agent.get("/api/v1/admin/staff").expect(401);
    expect(pending.body.code).toBe("SECOND_FACTOR_REQUIRED");
    const wrong = await agent
      .post("/api/v1/admin/auth/totp")
      .set("x-csrf-token", login.body.csrfToken)
      .send({ code: "000000" })
      .expect(401);
    expect(wrong.body.code).toBe("INVALID_CODE");
    await agent
      .post("/api/v1/admin/auth/totp")
      .set("x-csrf-token", login.body.csrfToken)
      .send({ code: nextCode(s.secret) })
      .expect(200);
    await agent.get("/api/v1/admin/auth/me").expect(200);
  });

  it("rejects a wrong password without revealing whether the email exists", async () => {
    const unknown = await request(http)
      .post("/api/v1/admin/auth/login")
      .send({ email: `nobody-${run}@example.com`, password: "x".repeat(12) })
      .expect(401);
    const wrong = await request(http)
      .post("/api/v1/admin/auth/login")
      .send({ email: owner.email, password: "wrong password!!" })
      .expect(401);
    expect(unknown.body.code).toBe("INVALID_CREDENTIALS");
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("locks the account after 5 failed attempts", async () => {
    const s = await signedInStaff("finance", "finance-lock");
    for (let i = 0; i < 5; i++)
      await request(http)
        .post("/api/v1/admin/auth/login")
        .send({ email: s.email, password: "wrong password!!" })
        .expect(401);
    const locked = await request(http)
      .post("/api/v1/admin/auth/login")
      .send({ email: s.email, password: PASSWORD })
      .expect(429);
    expect(locked.body.code).toBe("ACCOUNT_LOCKED");
  });

  it("rejects requests without a session, and writes without the CSRF token", async () => {
    expect((await request(http).get("/api/v1/admin/staff").expect(401)).body.code).toBe("UNAUTHENTICATED");
    const res = await owner.agent.post("/api/v1/admin/auth/step-up").send({ code: "123456" }).expect(403);
    expect(res.body.code).toBe("CSRF_INVALID");
  });
});

describe("permissions", () => {
  it("blocks a role from modules it doesn't include", async () => {
    const editor = await signedInStaff("content-editor", "editor");
    const res = await editor.agent.get("/api/v1/admin/staff").expect(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", missing: ["staff.read"] });
    const me = await editor.agent.get("/api/v1/admin/auth/me").expect(200);
    expect(me.body.permissions).toContain("content.publish");
    expect(me.body.permissions).not.toContain("refunds.approve");
  });

  it("requires a fresh authenticator code for role changes", async () => {
    const body = { name: `Print buyer ${run}`, permissions: ["orders.read", "quotes.read"] };
    const denied = await owner.agent.post("/api/v1/admin/roles").set("x-csrf-token", owner.csrf).send(body).expect(403);
    expect(denied.body.code).toBe("STEP_UP_REQUIRED");
    await stepUp(owner);
    const created = await owner.agent
      .post("/api/v1/admin/roles")
      .set("x-csrf-token", owner.csrf)
      .send(body)
      .expect(201);
    expect(created.body.permissions).toEqual(["orders.read", "quotes.read"]);
    const bad = await owner.agent
      .post("/api/v1/admin/roles")
      .set("x-csrf-token", owner.csrf)
      .send({ name: `Bad ${run}`, permissions: ["everything.ever"] })
      .expect(400);
    expect(bad.body.code).toBe("PERMISSION_UNKNOWN");
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { key: "owner" } });
    const locked = await owner.agent
      .patch(`/api/v1/admin/roles/${ownerRole.id}`)
      .set("x-csrf-token", owner.csrf)
      .send({ permissions: [] })
      .expect(409);
    expect(locked.body.code).toBe("ROLE_LOCKED");
  });

  it("invites staff with a one-time link and enforces password strength", async () => {
    const roles = (await owner.agent.get("/api/v1/admin/roles").expect(200)).body as { id: string; key: string }[];
    const prepress = roles.find((r) => r.key === "pre-press")!;
    const res = await owner.agent
      .post("/api/v1/admin/staff/invitations")
      .set("x-csrf-token", owner.csrf)
      .send({ email: `prepress-${run}@example.com`, name: "Pre-press operator", roleId: prepress.id })
      .expect(201);
    expect(res.body.inviteUrl).toMatch(/^http:\/\/localhost:5173\/accept-invite#token=/);
    const token = res.body.inviteUrl.split("#token=")[1];
    const weak = await request(http)
      .post("/api/v1/admin/auth/invitations/accept")
      .send({ token, password: "short" })
      .expect(400);
    expect(weak.body.code).toBe("PASSWORD_WEAK");
    const ok = await request(http)
      .post("/api/v1/admin/auth/invitations/accept")
      .send({ token, password: PASSWORD })
      .expect(200);
    expect(ok.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const reused = await request(http)
      .post("/api/v1/admin/auth/invitations/accept")
      .send({ token, password: PASSWORD })
      .expect(410);
    expect(reused.body.code).toBe("INVITATION_INVALID");
  });
});

describe("owner safeguards and deactivation", () => {
  it("never removes the last active Owner, and nobody changes their own role", async () => {
    const admin = await signedInStaff("admin", "admin");
    await stepUp(admin);
    const self = await admin.agent
      .patch(`/api/v1/admin/staff/${admin.userId}`)
      .set("x-csrf-token", admin.csrf)
      .send({ status: "DEACTIVATED" })
      .expect(409);
    expect(self.body.code).toBe("SELF_CHANGE_FORBIDDEN");
    const sales = await prisma.role.findUniqueOrThrow({ where: { key: "sales" } });
    const last = await admin.agent
      .patch(`/api/v1/admin/staff/${owner.userId}`)
      .set("x-csrf-token", admin.csrf)
      .send({ roleId: sales.id })
      .expect(409);
    expect(last.body.code).toBe("LAST_OWNER");
  });

  it("signs a deactivated person out immediately", async () => {
    const victim = await signedInStaff("production", "production");
    await victim.agent.get("/api/v1/admin/auth/me").expect(200);
    const admin = await signedInStaff("admin", "admin-2");
    await stepUp(admin);
    await admin.agent
      .patch(`/api/v1/admin/staff/${victim.userId}`)
      .set("x-csrf-token", admin.csrf)
      .send({ status: "DEACTIVATED" })
      .expect(200);
    await victim.agent.get("/api/v1/admin/auth/me").expect(401);
  });
});

describe("audit log", () => {
  it("records staff actions and can't be altered", async () => {
    const res = await owner.agent.get("/api/v1/admin/audit?limit=100").expect(200);
    const actions = (res.body.items as { action: string }[]).map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["staff.invited", "role.created", "auth.step_up", "staff.updated"]));
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    await expect(prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe("CORS", () => {
  it("lets only the admin origin send credentials", async () => {
    const admin = await request(http)
      .options("/api/v1/admin/auth/me")
      .set("Origin", ADMIN_ORIGIN)
      .set("Access-Control-Request-Method", "GET");
    expect(admin.headers["access-control-allow-credentials"]).toBe("true");
    const shop = await request(http).get("/api/v1/health").set("Origin", "http://localhost:3000");
    expect(shop.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(shop.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
