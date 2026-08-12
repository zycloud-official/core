import { Router } from "express";
import { prisma } from "../db.js";
import {
  listUserInstallations,
  listUserInstallationRepos,
} from "../integrations/github/client.js";
import { loadSession, requireSession } from "../middleware/session.js";
import { buildPacks } from "../detect.js";
import { generateAppName } from "../appName.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";

const MAX_NAME_ATTEMPTS = 5;

export const githubRoutes = Router();

// Shared GET/PATCH response shape. `EnvVar.value` is write-only for secret
// rows (redacted to null) — same rule as GitHub Actions secrets: you can
// replace a secret, never read it back once set.
function serializeAppConfig(app) {
  return {
    id: app.id,
    githubRepo: app.githubRepo,
    caproverAppName: app.caproverAppName,
    previewUrl: app.previewUrl,
    buildPack: app.config.buildPack,
    targetBranch: app.config.targetBranch,
    envVars: app.config.envVars.map((v) => ({
      id: v.id,
      key: v.key,
      secret: v.secret,
      value: v.secret ? null : decryptSecret(v.value),
    })),
  };
}

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
  const { githubRepo, installationId, buildPack, targetBranch, envVars } = req.body;

  if (!githubRepo || !installationId || !buildPack || !targetBranch) {
    return res.status(400).json({
      error: "githubRepo, installationId, buildPack, and targetBranch are required",
    });
  }

  if (!Object.keys(buildPacks).includes(buildPack)) {
    return res.status(400).json({ error: `Unknown buildPack: ${buildPack}` });
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

  // caproverAppName is randomly generated (free tier — no member input yet; a
  // future paid tier may let members choose their own). Retry on the rare
  // collision rather than trusting a pre-check to close the race.
  let app;
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const caproverAppName = generateAppName();
    try {
      app = await prisma.app.create({
        data: {
          githubRepo: `${owner}/${repo}`,
          caproverAppName,
          previewUrl: `https://${caproverAppName}.zycloud.space`,
          accountId: req.account.id,
          sourceConnectionId: connection.id,
          config: {
            create: {
              buildPack,
              targetBranch,
              envVars: {
                create: (envVars ?? []).map((v) => ({
                  key: v.key,
                  value: encryptSecret(v.value),
                  secret: !!v.secret,
                })),
              },
            },
          },
        },
        include: { config: true },
      });
      break;
    } catch (err) {
      const isNameCollision = err.code === "P2002" && err.meta?.target?.includes("caprover_app_name");
      if (isNameCollision && attempt < MAX_NAME_ATTEMPTS - 1) continue;
      throw err;
    }
  }

  res.status(201).json({
    githubRepo: app.githubRepo,
    caproverAppName: app.caproverAppName,
    previewUrl: app.previewUrl,
    configured: !!app.config,
    createdAt: app.createdAt,
  });
});

githubRoutes.get("/apps/:id", loadSession, requireSession, async (req, res) => {
  const appId = Number(req.params.id);
  if (!Number.isInteger(appId)) {
    return res.status(400).json({ error: "Invalid app id" });
  }

  // 404 (not 403) on a foreign app — don't reveal that the id exists.
  const app = await prisma.app.findFirst({
    where: { id: appId, accountId: req.account.id },
    include: { config: { include: { envVars: true } } },
  });
  if (!app?.config) {
    return res.status(404).json({ error: "App not found" });
  }

  res.json(serializeAppConfig(app));
});

// Config-only update — takes effect on the app's *next* push, since
// webhook.js already reads buildPack/targetBranch/envVars fresh from the DB
// on every deploy. No redeploy is triggered here.
githubRoutes.patch("/apps/:id", loadSession, requireSession, async (req, res) => {
  const appId = Number(req.params.id);
  if (!Number.isInteger(appId)) {
    return res.status(400).json({ error: "Invalid app id" });
  }

  const { buildPack, targetBranch, envVars } = req.body;
  if (!buildPack || !targetBranch) {
    return res.status(400).json({ error: "buildPack and targetBranch are required" });
  }
  if (!Object.keys(buildPacks).includes(buildPack)) {
    return res.status(400).json({ error: `Unknown buildPack: ${buildPack}` });
  }

  const app = await prisma.app.findFirst({
    where: { id: appId, accountId: req.account.id },
    include: { config: { include: { envVars: true } } },
  });
  if (!app?.config) {
    return res.status(404).json({ error: "App not found" });
  }

  // envVars is a full-replace keyed by id: entries with an id update that row
  // (value: null keeps the existing encrypted blob — how a secret survives an
  // edit the member didn't touch), entries without an id are created, and any
  // existing row whose id isn't present in the payload gets deleted. Omitting
  // envVars entirely leaves them untouched.
  const existingById = new Map(app.config.envVars.map((v) => [v.id, v]));
  const keepIds = new Set();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.appConfig.update({
        where: { id: app.config.id },
        data: { buildPack, targetBranch },
      });

      for (const v of envVars ?? []) {
        if (v.id != null) {
          const current = existingById.get(v.id);
          if (!current) {
            throw Object.assign(new Error(`Unknown envVar id: ${v.id}`), { status: 400 });
          }
          keepIds.add(v.id);
          await tx.envVar.update({
            where: { id: v.id },
            data: {
              key: v.key,
              secret: !!v.secret,
              value: v.value == null ? current.value : encryptSecret(v.value),
            },
          });
        } else {
          await tx.envVar.create({
            data: {
              appConfigId: app.config.id,
              key: v.key,
              secret: !!v.secret,
              value: encryptSecret(v.value ?? ""),
            },
          });
        }
      }

      if (envVars !== undefined) {
        const toDelete = app.config.envVars.filter((v) => !keepIds.has(v.id)).map((v) => v.id);
        if (toDelete.length) {
          await tx.envVar.deleteMany({ where: { id: { in: toDelete } } });
        }
      }
    });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const updated = await prisma.app.findUnique({
    where: { id: appId },
    include: { config: { include: { envVars: true } } },
  });
  res.json(serializeAppConfig(updated));
});
