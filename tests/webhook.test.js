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
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("x-github-event", event)
    .set("x-hub-signature-256", sign(body))
    .send(body);
}

describe("POST /webhook — signature verification", () => {
  it("returns 401 with no signature header", async () => {
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });

  it("returns 401 with an incorrect signature", async () => {
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .send(JSON.stringify({}));
    expect(res.status).toBe(401);
  });
});

describe("POST /webhook — push event", () => {
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

  it("queues a deploy on push to the default branch", async () => {
    await cleanDb();
    vi.clearAllMocks();
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

  it("creates an app and deploy row in the DB", async () => {
    await cleanDb();
    await webhookRequest("push", pushPayload("main"));

    const app = await prisma.app.findUnique({ where: { githubRepo: "alice/myrepo" } });
    expect(app?.caproverAppName).toBe("alice-myrepo");
    expect(app?.previewUrl).toBe("https://alice-myrepo.zycloud.space");

    const deploy = await prisma.deploy.findFirst({ where: { appId: app.id } });
    expect(deploy?.status).toBe("queued");
    expect(deploy?.commitSha).toBe("abc123def456");
  });

  it("sanitises owner/repo names into a valid CapRover app name", async () => {
    await cleanDb();
    const payload = {
      ref: "refs/heads/main",
      after: "abc123",
      installation: { id: 1 },
      repository: { name: "My.Repo", owner: { login: "My_Org" }, default_branch: "main" },
    };
    await webhookRequest("push", payload);
    const app = await prisma.app.findFirst();
    expect(app?.caproverAppName).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("POST /webhook — installation event", () => {
  it("creates an installation record when app is installed", async () => {
    await cleanDb();
    const res = await webhookRequest("installation", {
      action: "created",
      installation: { id: 999 },
      sender: { login: "Bob" },
    });
    expect(res.status).toBe(200);

    const inst = await prisma.installation.findUnique({ where: { githubInstallationId: 999 } });
    expect(inst?.githubUsername).toBe("bob");
  });

  it("links installation to an existing account on install", async () => {
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

    const inst = await prisma.installation.findUnique({ where: { githubInstallationId: 888 } });
    expect(inst?.accountId).toBe(account.id);
  });

  it("removes the installation record when app is uninstalled", async () => {
    await cleanDb();
    await prisma.installation.create({
      data: { githubInstallationId: 777, githubUsername: "dave" },
    });

    await webhookRequest("installation", {
      action: "deleted",
      installation: { id: 777 },
      sender: { login: "dave" },
    });

    const inst = await prisma.installation.findUnique({ where: { githubInstallationId: 777 } });
    expect(inst).toBeNull();
  });
});
