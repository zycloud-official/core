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

describe("GET /auth/github", () => {
  it("redirects to the GitHub OAuth URL", async () => {
    const res = await request(app).get("/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github.com");
  });
});

describe("GET /auth/callback", () => {
  it("returns 400 when no code param is present", async () => {
    const res = await request(app).get("/auth/callback");
    expect(res.status).toBe(400);
  });

  it("creates a member record and sets a session cookie on valid code", async () => {
    await cleanDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 1001, login: "Alice", avatar_url: "https://avatars.example.com/alice" }),
    }));

    const res = await request(app).get("/auth/callback?code=validcode");
    expect(res.status).toBe(302);
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.headers["set-cookie"][0]).toContain("session=");

    const member = await prisma.member.findUnique({ where: { githubUserId: 1001 } });
    expect(member?.githubUsername).toBe("alice");
  });

  it("updates existing member on repeat login", async () => {
    await cleanDb();
    await prisma.member.create({
      data: { githubUserId: 2002, githubUsername: "bob_old", sessionToken: "old-token" },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 2002, login: "Bob", avatar_url: "" }),
    }));

    await request(app).get("/auth/callback?code=anycode");

    const member = await prisma.member.findUnique({ where: { githubUserId: 2002 } });
    expect(member?.githubUsername).toBe("bob");
    expect(member?.sessionToken).not.toBe("old-token");
  });

  it("links a pre-existing installation to the member at OAuth time", async () => {
    await cleanDb();
    await prisma.installation.create({
      data: { githubInstallationId: 555, githubUsername: "carol" },
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 3003, login: "Carol", avatar_url: "" }),
    }));

    await request(app).get("/auth/callback?code=anycode");

    const member = await prisma.member.findUnique({ where: { githubUserId: 3003 } });
    const inst = await prisma.installation.findUnique({ where: { githubInstallationId: 555 } });
    expect(inst?.memberId).toBe(member?.id);
  });
});

describe("POST /auth/logout", () => {
  it("clears the session token and cookie", async () => {
    await cleanDb();
    await prisma.member.create({
      data: { githubUserId: 4004, githubUsername: "dave", sessionToken: "token-to-clear" },
    });

    const res = await request(app)
      .post("/auth/logout")
      .set("Cookie", "session=token-to-clear");

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toContain("session=;");

    const member = await prisma.member.findUnique({ where: { githubUserId: 4004 } });
    expect(member?.sessionToken).toBeNull();
  });
});
