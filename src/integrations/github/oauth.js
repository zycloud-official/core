import { Router } from "express";
import { githubApp } from "./client.js";
import { prisma } from "../../db.js";
import { createSession, clearSession } from "../../middleware/session.js";

export const githubOAuthRoutes = Router();

// GitHub is one login *method* (and the repo-source integration) — not the
// identity. The callback resolves the provider-agnostic zycloud Account behind
// this GitHub user, attaching a GITHUB AuthIdentity, then opens a session.

// Step 1: redirect to GitHub OAuth
githubOAuthRoutes.get("/auth/github", (_req, res) => {
  const { url } = githubApp.oauth.getWebFlowAuthorizationUrl({
    scopes: [],
    redirectUrl: `${process.env.BASE_URL}/auth/callback`,
  });
  res.redirect(url);
});

// Step 2: GitHub redirects back with ?code=
githubOAuthRoutes.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Missing OAuth code" });

  const { authentication } = await githubApp.oauth.createToken({ code });

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${authentication.token}`,
      "User-Agent": "github-integration/1.0",
    },
  });
  if (!userRes.ok)
    return res.status(502).json({ error: "Failed to fetch GitHub user" });
  const user = await userRes.json();

  const username = user.login.toLowerCase();
  const subject = String(user.id);
  const profile = {
    displayName: user.name || username,
    avatarUrl: user.avatar_url || null,
  };

  // Resolve or create the account behind this GitHub identity.
  const identity = await prisma.authIdentity.findUnique({
    where: { provider_providerSubject: { provider: "GITHUB", providerSubject: subject } },
  });

  let account;
  if (identity) {
    account = await prisma.account.update({
      where: { id: identity.accountId },
      data: {
        ...profile,
        ...(user.email ? { email: user.email } : {}),
      },
    });
    await prisma.authIdentity.update({
      where: { id: identity.id },
      data: { providerUsername: username },
    });
  } else {
    account = await prisma.account.create({
      data: {
        ...profile,
        ...(user.email ? { email: user.email } : {}),
        identities: {
          create: { provider: "GITHUB", providerSubject: subject, providerUsername: username },
        },
      },
    });
  }

  // Link any GitHub source connections that arrived before this user signed in.
  await prisma.sourceConnection.updateMany({
    where: { provider: "GITHUB", ownerLogin: username, accountId: null },
    data: { accountId: account.id },
  });

  await createSession(res, account.id);
  res.redirect(`${process.env.BASE_URL}/dashboard`);
});

githubOAuthRoutes.post("/auth/logout", async (req, res) => {
  await clearSession(res, req.cookies?.session);
  res.json({ ok: true });
});
