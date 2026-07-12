import { Router } from "express";
import { prisma } from "../db.js";
import { githubApp } from "../integrations/github/client.js";
import { loadSession, requireSession } from "../middleware/session.js";

export const githubRoutes = Router();

githubRoutes.get("/github/repos", loadSession, requireSession, async (req, res) => {
  const connections = await prisma.sourceConnection.findMany({
    where: { accountId: req.account.id, provider: "GITHUB" },
  });

  if (connections.length === 0) {
    return res.json([]);
  }

  const connectedRepos = await prisma.app.findMany({
    where: { accountId: req.account.id },
    select: { githubRepo: true },
  });
  const connectedSet = new Set(connectedRepos.map((a) => a.githubRepo));

  const results = [];

  await Promise.all(
    connections.map(async (conn) => {
      const octokit = await githubApp.getInstallationOctokit(Number(conn.externalId));
      const { data } = await octokit.request("GET /installation/repositories", {
        per_page: 100,
      });
      for (const repo of data.repositories) {
        const githubRepo = repo.full_name.toLowerCase();
        results.push({
          githubRepo,
          installationId: Number(conn.externalId),
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
