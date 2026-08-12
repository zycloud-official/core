import { Router } from "express";
import { prisma } from "../db.js";
import { loadSession, requireSession } from "../middleware/session.js";

export const dashboardRoutes = Router();

dashboardRoutes.get("/dashboard", loadSession, requireSession, async (req, res) => {
  const account = req.account;

  const apps = await prisma.app.findMany({
    where: { accountId: account.id },
    include: {
      config: true,
      deploys: {
        orderBy: { id: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({
    account: {
      id: account.id,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      email: account.email,
      role: account.role,
      tier: account.tier,
    },
    apps: apps.map((app) => ({
      id: app.id,
      githubRepo: app.githubRepo,
      caproverAppName: app.caproverAppName,
      previewUrl: app.previewUrl,
      configured: !!app.config,
      createdAt: app.createdAt,
      lastStatus: app.deploys[0]?.status ?? null,
      lastCommit: app.deploys[0]?.commitSha ?? null,
      lastDeployAt: app.deploys[0]?.createdAt ?? null,
    })),
    installUrl: `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`,
  });
});
