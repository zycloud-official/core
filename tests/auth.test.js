import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/db.js";
import { cleanDb } from "./helpers.js";

vi.mock("../src/integrations/github/client.js", () => ({
  githubApp: {
    oauth: {
      getWebFlowAuthorizationUrl: vi.fn().mockReturnValue({
        url: "https://github.com/login/oauth/authorize?client_id=test",
      }),
      createToken: vi.fn().mockResolvedValue({
        authentication: { token: "gho_test_token" },
      }),
    },
  },
  downloadTarball: vi.fn(),
}));

const { default: app } = await import("../src/app.js");

// Find the account behind a GitHub identity, by the provider subject (user id).
function accountByGithubId(id) {
  return prisma.account.findFirst({
    where: { identities: { some: { provider: "GITHUB", providerSubject: String(id) } } },
    include: { identities: true, sessions: true },
  });
}

describe("GET /auth/github", () => {
  it("redirects to the GitHub OAuth URL", async () => {
    const res = await request(app).get("/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github.com");
  });
});

describe("GET /callback/github", () => {
  it("returns 400 when no code param is present", async () => {
    const res = await request(app).get("/callback/github");
    expect(res.status).toBe(400);
  });

  it("creates an account + GITHUB identity + session on valid code", async () => {
    await cleanDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1001, login: "Alice", avatar_url: "https://avatars.example.com/alice" }),
    }));

    const res = await request(app).get("/callback/github?code=validcode");
    expect(res.status).toBe(302);
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.headers["set-cookie"][0]).toContain("session=");

    const account = await accountByGithubId(1001);
    expect(account).not.toBeNull();
    expect(account.displayName).toBe("alice");
    expect(account.identities[0].providerUsername).toBe("alice");
    expect(account.sessions).toHaveLength(1);
  });

  it("reuses the same account (no duplicate) on repeat login", async () => {
    await cleanDb();
    // First login.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 2002, login: "bob_old", avatar_url: "" }),
    }));
    await request(app).get("/callback/github?code=first");
    const first = await accountByGithubId(2002);

    // Second login — GitHub handle changed; same underlying user id.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 2002, login: "Bob", avatar_url: "" }),
    }));
    await request(app).get("/callback/github?code=second");

    const accounts = await prisma.account.findMany({
      where: { identities: { some: { provider: "GITHUB", providerSubject: "2002" } } },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(first.id);
    expect(accounts[0].displayName).toBe("bob");

    // A fresh session was minted (two logins → two sessions for the account).
    const sessions = await prisma.session.count({ where: { accountId: first.id } });
    expect(sessions).toBe(2);
  });

  it("links a pre-existing source connection to the account at OAuth time", async () => {
    await cleanDb();
    await prisma.sourceConnection.create({
      data: { provider: "GITHUB", externalId: "555", ownerLogin: "carol" },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 3003, login: "Carol", avatar_url: "" }),
    }));

    await request(app).get("/callback/github?code=anycode");

    const account = await accountByGithubId(3003);
    const conn = await prisma.sourceConnection.findUnique({
      where: { provider_externalId: { provider: "GITHUB", externalId: "555" } },
    });
    expect(conn?.accountId).toBe(account.id);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session row and clears the cookie", async () => {
    await cleanDb();
    const account = await prisma.account.create({ data: { displayName: "dave" } });
    await prisma.session.create({
      data: {
        token: "token-to-clear",
        accountId: account.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await request(app)
      .post("/auth/logout")
      .set("Cookie", "session=token-to-clear");

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toContain("session=;");

    const session = await prisma.session.findUnique({ where: { token: "token-to-clear" } });
    expect(session).toBeNull();
  });
});
