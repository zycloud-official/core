import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { prisma } from "../src/db.js";
import { cleanDb } from "./helpers.js";

vi.mock("../src/deploy.js", () => ({
  deployApp: vi.fn().mockResolvedValue(undefined),
}));

// Prevent src/integrations/github/oauth.js from crashing on import —
// it reads GITHUB_APP_PRIVATE_KEY at module init time via src/integrations/github/client.js
vi.mock("../src/integrations/github/client.js", () => ({
  githubApp: { oauth: {} },
  downloadTarball: vi.fn(),
}));

const { default: app } = await import("../src/app.js");
const { deployApp } = await import("../src/deploy.js");

const SECRET = "test-webhook-secret";

function sign(body) {
  const str = typeof body === "string" ? body : JSON.stringify(body);
  return "sha256=" + createHmac("sha256", SECRET).update(str).digest("hex");
}

function webhookRequest(event, payload) {
  const body = JSON.stringify(payload);
  return request(app)
    .post("/webhook/github")
    .set("Content-Type", "application/json")
    .set("x-github-event", event)
    .set("x-hub-signature-256", sign(body))
    .send(body);
}

describe("POST /webhook/github — signature verification", () => {
  it("returns 401 with no signature header", async () => {
    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });

  it("returns 401 with an incorrect signature", async () => {
    const res = await request(app)
      .post("/webhook/github")
      .set("Content-Type", "application/json")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });
});

describe("POST /webhook/github — push event", () => {
  const pushPayload = (branch = "main") => ({
    ref: `refs/heads/${branch}`,
    after: "abc123def456",
    installation: { id: 42 },
    repository: {
      name: "myrepo",
      owner: { login: "Alice" },
      default_branch: "main",
    },
  });

  it("ignores pushes to non-default branches", async () => {
    vi.clearAllMocks();
    const res = await webhookRequest("push", pushPayload("feature-xyz"));
    expect(res.status).toBe(200);
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("skips deploy when repo is not connected (no App record)", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const res = await webhookRequest("push", pushPayload("main"));
    expect(res.status).toBe(200);
    expect(deployApp).not.toHaveBeenCalled();
    expect(await prisma.deploy.findFirst()).toBeNull();
  });

  it("skips deploy when repo is connected but not configured (no AppConfig)", async () => {
    await cleanDb();
    vi.clearAllMocks();
    await prisma.app.create({
      data: { githubRepo: "alice/myrepo", caproverAppName: "alice-myrepo" },
    });
    const res = await webhookRequest("push", pushPayload("main"));
    expect(res.status).toBe(200);
    expect(deployApp).not.toHaveBeenCalled();
    expect(await prisma.deploy.findFirst()).toBeNull();
  });

  it("queues a deploy when repo is connected and configured", async () => {
    await cleanDb();
    vi.clearAllMocks();
    await prisma.app.create({
      data: {
        githubRepo: "alice/myrepo",
        caproverAppName: "alice-myrepo",
        config: { create: {} },
      },
    });
    const res = await webhookRequest("push", pushPayload("main"));
    expect(res.status).toBe(200);
    expect(deployApp).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "alice",
        repo: "myrepo",
        sha: "abc123def456",
        installationId: 42,
        appName: "alice-myrepo",
      })
    );
  });

  it("creates a deploy row in the DB when repo is connected and configured", async () => {
    await cleanDb();
    const seededApp = await prisma.app.create({
      data: {
        githubRepo: "alice/myrepo",
        caproverAppName: "alice-myrepo",
        previewUrl: "https://alice-myrepo.zycloud.space",
        config: { create: {} },
      },
    });
    await webhookRequest("push", pushPayload("main"));

    const deploy = await prisma.deploy.findFirst({ where: { appId: seededApp.id } });
    expect(deploy?.status).toBe("queued");
    expect(deploy?.commitSha).toBe("abc123def456");
  });

  it("sanitises owner/repo names into a valid CapRover app name", async () => {
    await cleanDb();
    await prisma.app.create({
      data: {
        githubRepo: "my_org/my.repo",
        caproverAppName: "my-org-my-repo",
        config: { create: {} },
      },
    });
    const payload = {
      ref: "refs/heads/main",
      after: "abc123",
      installation: { id: 1 },
      repository: { name: "My.Repo", owner: { login: "My_Org" }, default_branch: "main" },
    };
    await webhookRequest("push", payload);
    const deploy = await prisma.deploy.findFirst();
    expect(deploy).not.toBeNull();
  });
});

describe("POST /webhook/github — installation event", () => {
  const connByExternalId = (externalId) =>
    prisma.sourceConnection.findUnique({
      where: { provider_externalId: { provider: "GITHUB", externalId } },
    });

  it("creates a source connection when the app is installed", async () => {
    await cleanDb();
    const res = await webhookRequest("installation", {
      action: "created",
      installation: { id: 999 },
      sender: { login: "Bob" },
    });
    expect(res.status).toBe(200);

    const conn = await connByExternalId("999");
    expect(conn?.provider).toBe("GITHUB");
    expect(conn?.ownerLogin).toBe("bob");
  });

  it("links the source connection to an existing account on install", async () => {
    await cleanDb();
    const account = await prisma.account.create({
      data: {
        displayName: "carol",
        identities: {
          create: { provider: "GITHUB", providerSubject: "1", providerUsername: "carol" },
        },
      },
    });

    await webhookRequest("installation", {
      action: "created",
      installation: { id: 888 },
      sender: { login: "Carol" },
    });

    const conn = await connByExternalId("888");
    expect(conn?.accountId).toBe(account.id);
  });

  it("removes the source connection when the app is uninstalled", async () => {
    await cleanDb();
    await prisma.sourceConnection.create({
      data: { provider: "GITHUB", externalId: "777", ownerLogin: "dave" },
    });

    await webhookRequest("installation", {
      action: "deleted",
      installation: { id: 777 },
      sender: { login: "dave" },
    });

    expect(await connByExternalId("777")).toBeNull();
  });
});
