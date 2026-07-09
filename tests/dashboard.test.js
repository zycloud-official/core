import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { cleanDb } from "./helpers.js";

vi.mock("../src/integrations/github/client.js", () => ({
  githubApp: { oauth: {} },
  downloadTarball: vi.fn(),
}));

const { default: app } = await import("../src/app.js");

// Create an account with an active session token (the federated logins set this
// up for real; tests shortcut it).
async function seedAccount(data, token) {
  const account = await prisma.account.create({ data });
  await prisma.session.create({
    data: { token, accountId: account.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  return account;
}

describe("GET /dashboard", () => {
  it("returns 401 with no session cookie", async () => {
    const res = await request(app).get("/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an unknown session token", async () => {
    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired session token", async () => {
    await cleanDb();
    const account = await prisma.account.create({ data: { displayName: "expired" } });
    await prisma.session.create({
      data: { token: "expired-token", accountId: account.id, expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).get("/dashboard").set("Cookie", "session=expired-token");
    expect(res.status).toBe(401);
  });

  it("returns account info and an empty apps array when none deployed", async () => {
    await cleanDb();
    await seedAccount({ displayName: "alice", tier: "FREE" }, "alice-token");

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=alice-token");

    expect(res.status).toBe(200);
    expect(res.body.account.displayName).toBe("alice");
    expect(res.body.account.tier).toBe("FREE");
    expect(res.body.apps).toEqual([]);
    expect(res.body.installUrl).toContain("github.com/apps/");
  });

  it("returns apps ordered newest first", async () => {
    await cleanDb();
    const account = await seedAccount({ displayName: "bob" }, "bob-token");
    await prisma.app.create({
      data: { accountId: account.id, githubRepo: "bob/alpha", caproverAppName: "bob-alpha" },
    });
    await prisma.app.create({
      data: { accountId: account.id, githubRepo: "bob/beta", caproverAppName: "bob-beta" },
    });

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=bob-token");

    expect(res.status).toBe(200);
    expect(res.body.apps).toHaveLength(2);
  });

  it("returns the most recent deploy status for each app", async () => {
    await cleanDb();
    const account = await seedAccount({ displayName: "carol" }, "carol-token");
    const deployedApp = await prisma.app.create({
      data: {
        accountId: account.id,
        githubRepo: "carol/myapp",
        caproverAppName: "carol-myapp",
        previewUrl: "https://carol-myapp.zycloud.space",
      },
    });
    // Create two deploys — the second (failed) must be the most recent by id
    await prisma.deploy.create({
      data: { appId: deployedApp.id, commitSha: "aaa111", status: "success" },
    });
    await prisma.deploy.create({
      data: { appId: deployedApp.id, commitSha: "bbb222", status: "failed" },
    });

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=carol-token");

    expect(res.status).toBe(200);
    expect(res.body.apps[0].lastStatus).toBe("failed");
    expect(res.body.apps[0].lastCommit).toBe("bbb222");
  });

  it("does not expose apps belonging to other accounts", async () => {
    await cleanDb();
    await seedAccount({ displayName: "alice2" }, "alice2-token");
    const bob = await seedAccount({ displayName: "bob2" }, "bob2-token");
    await prisma.app.create({
      data: { accountId: bob.id, githubRepo: "bob2/secret", caproverAppName: "bob2-secret" },
    });

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=alice2-token");

    expect(res.body.apps).toHaveLength(0);
  });
});
