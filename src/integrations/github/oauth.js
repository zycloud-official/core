import { Router } from "express";
import { randomBytes } from "node:crypto";
import { githubApp } from "./client.js";
import { prisma } from "../../db.js";

export const githubOAuthRoutes = Router();

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

  const sessionToken = randomBytes(32).toString("hex");

  const member = await prisma.member.upsert({
    where: { githubUserId: user.id },
    create: {
      githubUserId: user.id,
      githubUsername: user.login.toLowerCase(),
      avatarUrl: user.avatar_url,
      sessionToken,
    },
    update: {
      githubUsername: user.login.toLowerCase(),
      avatarUrl: user.avatar_url,
      sessionToken,
    },
  });

  // Link any installations that arrived before this user OAuth'd
  await prisma.installation.updateMany({
    where: { githubUsername: user.login.toLowerCase(), memberId: null },
    data: { memberId: member.id },
  });

  res.cookie("session", sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
  });
  res.redirect(`${process.env.BASE_URL}/dashboard`);
});

githubOAuthRoutes.post("/auth/logout", async (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    await prisma.member.updateMany({
      where: { sessionToken: token },
      data: { sessionToken: null },
    });
  }
  res.clearCookie("session", { path: "/" }).json({ ok: true });
});
