import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { cleanDb } from "./helpers.js";

// Mock the GitHub client — tests control what the user-token discovery returns.
vi.mock("../src/integrations/github/client.js", () => ({
  githubApp: { oauth: {} },
  listUserInstallations: vi.fn(),
  listUserInstallationRepos: vi.fn(),
  downloadTarball: vi.fn(),
}));

const { default: app } = await import("../src/app.js");
const { listUserInstallations, listUserInstallationRepos } = await import(
  "../src/integrations/github/client.js"
);

// Seeds an account with a GITHUB identity carrying an OAuth token (the token is
// what /github/repos uses to discover installations).
async function seedAccount(data, token) {
  const account = await prisma.account.create({
    data: {
      ...data,
      identities: {
        create: {
          provider: "GITHUB",
          providerSubject: `sub-${token}`,
          providerUsername: (data.displayName ?? "user").toLowerCase(),
          accessToken: `gho_${token}`,
        },
      },
    },
  });
  await prisma.session.create({
    data: { token, accountId: account.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  return account;
}

function makeRepos(repos) {
  return repos.map((r) => ({ full_name: r, default_branch: "main", private: false }));
}

describe("GET /github/repos", () => {
  beforeEach(async () => {
    await cleanDb();
    listUserInstallations.mockReset();
    listUserInstallationRepos.mockReset();
  });

  it("returns 401 with no session", async () => {
    const res = await request(app).get("/github/repos");
    expect(res.status).toBe(401);
  });

  it("returns empty array when user has no installations", async () => {
    await seedAccount({ displayName: "alice" }, "alice-token");
    listUserInstallations.mockResolvedValue([]);

    const res = await request(app).get("/github/repos").set("Cookie", "session=alice-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("lists repos from the user's installations with connected flag", async () => {
    const account = await seedAccount({ displayName: "bob" }, "bob-token");
    await prisma.app.create({
      data: {
        githubRepo: "bob/connected-repo",
        caproverAppName: "bob-connected-repo",
        accountId: account.id,
        config: { create: {} },
      },
    });

    listUserInstallations.mockResolvedValue([{ id: 42, account: { login: "bob" } }]);
    listUserInstallationRepos.mockResolvedValue(
      makeRepos(["bob/connected-repo", "bob/other-repo"])
    );

    const res = await request(app).get("/github/repos").set("Cookie", "session=bob-token");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const connected = res.body.find((r) => r.githubRepo === "bob/connected-repo");
    const other = res.body.find((r) => r.githubRepo === "bob/other-repo");
    expect(connected.connected).toBe(true);
    expect(connected.installationId).toBe(42);
    expect(other.connected).toBe(false);

    // The discovered installation is mirrored into a SourceConnection so a
    // subsequent POST /apps can validate ownership.
    const conn = await prisma.sourceConnection.findUnique({
      where: { provider_externalId: { provider: "GITHUB", externalId: "42" } },
    });
    expect(conn?.accountId).toBe(account.id);
  });

  it("scopes discovery to the authenticated user's own token", async () => {
    await seedAccount({ displayName: "alice2" }, "alice2-token");
    await seedAccount({ displayName: "bob2" }, "bob2-token");
    listUserInstallations.mockResolvedValue([]);

    const res = await request(app).get("/github/repos").set("Cookie", "session=bob2-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // Discovery ran against bob2's stored token — not alice2's.
    expect(listUserInstallations).toHaveBeenCalledWith("gho_bob2-token");
  });

  it("returns 400 when the account has no linked GitHub token", async () => {
    // Account with a session but no GITHUB identity/token.
    const account = await prisma.account.create({ data: { displayName: "tokenless" } });
    await prisma.session.create({
      data: { token: "tokenless", accountId: account.id, expiresAt: new Date(Date.now() + 60_000) },
    });

    const res = await request(app).get("/github/repos").set("Cookie", "session=tokenless");
    expect(res.status).toBe(400);
  });
});

describe("POST /apps", () => {
  beforeEach(cleanDb);

  it("returns 401 with no session", async () => {
    const res = await request(app)
      .post("/apps")
      .send({ githubRepo: "alice/myrepo", installationId: 1 });
    expect(res.status).toBe(401);
  });

  it("returns 400 when body fields are missing", async () => {
    await seedAccount({ displayName: "alice" }, "alice-token");
    const res = await request(app)
      .post("/apps")
      .set("Cookie", "session=alice-token")
      .send({ githubRepo: "alice/myrepo" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed githubRepo", async () => {
    await seedAccount({ displayName: "alice" }, "alice-token");
    const res = await request(app)
      .post("/apps")
      .set("Cookie", "session=alice-token")
      .send({ githubRepo: "not-a-valid-repo", installationId: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 403 when installationId does not belong to the user", async () => {
    await seedAccount({ displayName: "alice" }, "alice-token");
    const res = await request(app)
      .post("/apps")
      .set("Cookie", "session=alice-token")
      .send({ githubRepo: "alice/myrepo", installationId: 999 });
    expect(res.status).toBe(403);
  });

  it("creates App and AppConfig and returns 201", async () => {
    const account = await seedAccount({ displayName: "alice" }, "alice-token");
    await prisma.sourceConnection.create({
      data: { provider: "GITHUB", externalId: "42", ownerLogin: "alice", accountId: account.id },
    });

    const res = await request(app)
      .post("/apps")
      .set("Cookie", "session=alice-token")
      .send({ githubRepo: "alice/myrepo", installationId: 42 });

    expect(res.status).toBe(201);
    expect(res.body.githubRepo).toBe("alice/myrepo");
    expect(res.body.caproverAppName).toBe("alice-myrepo");
    expect(res.body.previewUrl).toBe("https://alice-myrepo.zycloud.space");
    expect(res.body.configured).toBe(true);

    const dbApp = await prisma.app.findUnique({
      where: { githubRepo: "alice/myrepo" },
      include: { config: true },
    });
    expect(dbApp?.accountId).toBe(account.id);
    expect(dbApp?.config).not.toBeNull();
  });

  it("normalises repo name to lowercase", async () => {
    const account = await seedAccount({ displayName: "alice" }, "alice-token");
    await prisma.sourceConnection.create({
      data: { provider: "GITHUB", externalId: "42", ownerLogin: "alice", accountId: account.id },
    });

    const res = await request(app)
      .post("/apps")
      .set("Cookie", "session=alice-token")
      .send({ githubRepo: "Alice/MyRepo", installationId: 42 });

    expect(res.status).toBe(201);
    expect(res.body.githubRepo).toBe("alice/myrepo");
  });

  it("returns 409 when repo is already connected", async () => {
    const account = await seedAccount({ displayName: "alice" }, "alice-token");
    const conn = await prisma.sourceConnection.create({
      data: { provider: "GITHUB", externalId: "42", ownerLogin: "alice", accountId: account.id },
    });
    await prisma.app.create({
      data: {
        githubRepo: "alice/myrepo",
        caproverAppName: "alice-myrepo",
        accountId: account.id,
        sourceConnectionId: conn.id,
      },
    });

    const res = await request(app)
      .post("/apps")
      .set("Cookie", "session=alice-token")
      .send({ githubRepo: "alice/myrepo", installationId: 42 });

    expect(res.status).toBe(409);
  });
});
