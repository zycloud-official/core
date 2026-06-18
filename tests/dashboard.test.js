import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { cleanDb } from "./helpers.js";

vi.mock("../src/integrations/github/client.js", () => ({
  githubApp: { oauth: {} },
  downloadTarball: vi.fn(),
}));

const { default: app } = await import("../src/app.js");

describe("GET /dashboard", () => {
  it("redirects to /auth/github with no session cookie", async () => {
    const res = await request(app).get("/dashboard");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/auth/github");
  });

  it("redirects with an unknown session token", async () => {
    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=not-a-real-token");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/auth/github");
  });

  it("returns member info and an empty apps array when none deployed", async () => {
    await cleanDb();
    await prisma.member.create({
      data: { githubUserId: 1, githubUsername: "alice", sessionToken: "alice-token" },
    });

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=alice-token");

    expect(res.status).toBe(200);
    expect(res.body.member.username).toBe("alice");
    expect(res.body.apps).toEqual([]);
    expect(res.body.installUrl).toContain("github.com/apps/");
  });

  it("returns apps ordered newest first", async () => {
    await cleanDb();
    const member = await prisma.member.create({
      data: { githubUserId: 2, githubUsername: "bob", sessionToken: "bob-token" },
    });
    await prisma.app.create({
      data: { memberId: member.id, githubRepo: "bob/alpha", caproverAppName: "bob-alpha" },
    });
    await prisma.app.create({
      data: { memberId: member.id, githubRepo: "bob/beta", caproverAppName: "bob-beta" },
    });

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=bob-token");

    expect(res.status).toBe(200);
    expect(res.body.apps).toHaveLength(2);
  });

  it("returns the most recent deploy status for each app", async () => {
    await cleanDb();
    const member = await prisma.member.create({
      data: { githubUserId: 3, githubUsername: "carol", sessionToken: "carol-token" },
    });
    const deployedApp = await prisma.app.create({
      data: {
        memberId: member.id,
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

  it("does not expose apps belonging to other members", async () => {
    await cleanDb();
    const alice = await prisma.member.create({
      data: { githubUserId: 4, githubUsername: "alice2", sessionToken: "alice2-token" },
    });
    const bob = await prisma.member.create({
      data: { githubUserId: 5, githubUsername: "bob2", sessionToken: "bob2-token" },
    });
    await prisma.app.create({
      data: { memberId: bob.id, githubRepo: "bob2/secret", caproverAppName: "bob2-secret" },
    });

    const res = await request(app)
      .get("/dashboard")
      .set("Cookie", "session=alice2-token");

    expect(res.body.apps).toHaveLength(0);
  });
});
