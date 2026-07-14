import { Router } from "express";
import { prisma } from "../db.js";
import {
  listUserInstallations,
  listUserInstallationRepos,
} from "../integrations/github/client.js";
import { loadSession, requireSession } from "../middleware/session.js";

export const githubRoutes = Router();

// Lists every repo the member can deploy, discovered LIVE from GitHub via their
// stored OAuth token — not from webhook-populated SourceConnection rows (those
// never arrive on a local dev server). Each repo is flagged `connected` if it
// already has a zycloud app.
githubRoutes.get("/github/repos", loadSession, requireSession, async (req, res) => {
  const identity = await prisma.authIdentity.findFirst({
    where: { accountId: req.account.id, provider: "GITHUB" },
  });
  if (!identity?.accessToken) {
    return res.status(400).json({ error: "GitHub account not linked" });
  }

  let installations;
  try {
    installations = await listUserInstallations(identity.accessToken);
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ error: "GitHub session expired — sign in again" });
    }
    throw err;
  }

  // Mirror the live installations into SourceConnection rows so POST /apps can
  // validate ownership. The user token already proved access, so it's safe to
  // (re)claim each installation for this account.
  await Promise.all(
    installations.map((inst) =>
      prisma.sourceConnection.upsert({
        where: {
          provider_externalId: { provider: "GITHUB", externalId: String(inst.id) },
        },
        create: {
          provider: "GITHUB",
          externalId: String(inst.id),
          ownerLogin: (inst.account?.login ?? "").toLowerCase(),
          accountId: req.account.id,
        },
        update: { accountId: req.account.id },
      })
    )
  );

  const connectedRepos = await prisma.app.findMany({
    where: { accountId: req.account.id },
    select: { githubRepo: true },
  });
  const connectedSet = new Set(connectedRepos.map((a) => a.githubRepo));

  const results = [];
  await Promise.all(
    installations.map(async (inst) => {
      const repos = await listUserInstallationRepos(inst.id, identity.accessToken);
      for (const repo of repos) {
        const githubRepo = repo.full_name.toLowerCase();
        results.push({
          githubRepo,
          installationId: inst.id,
          defaultBranch: repo.default_branch,
          private: repo.private,
          connected: connectedSet.has(githubRepo),
        });
      }
    })
  );

  res.json(results);
});

githubRoutes.post("/apps", loadSession, requireSession, async (req, res) => {
  const { githubRepo, installationId } = req.body;

  if (!githubRepo || !installationId) {
    return res.status(400).json({ error: "githubRepo and installationId are required" });
  }

  const parts = githubRepo.toLowerCase().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return res.status(400).json({ error: "githubRepo must be in owner/repo format" });
  }
  const [owner, repo] = parts;

  const connection = await prisma.sourceConnection.findFirst({
    where: {
      provider: "GITHUB",
      externalId: String(installationId),
      accountId: req.account.id,
    },
  });
  if (!connection) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const existing = await prisma.app.findUnique({ where: { githubRepo: `${owner}/${repo}` } });
  if (existing) {
    return res.status(409).json({ error: "Repo already connected" });
  }

  const appName = `${owner}-${repo}`.replace(/[^a-z0-9-]/g, "-");

  const app = await prisma.app.create({
    data: {
      githubRepo: `${owner}/${repo}`,
      caproverAppName: appName,
      previewUrl: `https://${appName}.zycloud.space`,
      accountId: req.account.id,
      sourceConnectionId: connection.id,
      config: { create: {} },
    },
    include: { config: true },
  });

  res.status(201).json({
    githubRepo: app.githubRepo,
    caproverAppName: app.caproverAppName,
    previewUrl: app.previewUrl,
    configured: !!app.config,
    createdAt: app.createdAt,
  });
});
