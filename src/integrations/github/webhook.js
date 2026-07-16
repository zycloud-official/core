import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db.js";
import { deployApp } from "../../deploy.js";

export const githubWebhookRoutes = Router();

function verifySignature(rawBody, signature, secret) {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

githubWebhookRoutes.post("/webhook/github", async (req, res) => {
  const sig = req.headers["x-hub-signature-256"];
  if (
    !sig ||
    !verifySignature(req.rawBody, sig, process.env.GITHUB_WEBHOOK_SECRET)
  ) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"];
  const delivery = req.headers["x-github-delivery"] ?? "unknown";
  const payload = req.body;

  console.log(`[webhook] ${event} (delivery: ${delivery})`);

  switch (event) {
    case "push":
      await handlePush(payload);
      break;
    case "installation":
      await handleInstallation(payload);
      break;
    case "installation_repositories":
      handleInstallationRepos(payload);
      break;
    default:
      console.log(`[webhook] Unhandled event: ${event}`);
  }

  res.json({ ok: true });
});

async function handlePush(payload) {
  const { repository, installation, ref, after: sha } = payload;

  if (!installation) {
    console.log("[webhook] Push has no installation context — ignoring");
    return;
  }

  const owner = repository.owner.login.toLowerCase();
  const repo = repository.name.toLowerCase();
  const installationId = installation.id;

  // Look up app + config BEFORE the branch check — the target branch is now
  // member-chosen (app.config.targetBranch), not GitHub's default_branch, so
  // we need the DB row before we can even know which branch to compare against.
  // envVars isn't included here — most pushes (feature branches, PRs) get
  // discarded by the checks below, so it's only fetched once a deploy is certain.
  const app = await prisma.app.findUnique({
    where: { githubRepo: `${owner}/${repo}` },
    include: { config: true },
  });

  if (!app) {
    console.log(`[webhook] Deploy skipped — ${owner}/${repo} not connected`);
    return;
  }
  if (!app.config) {
    console.log(`[webhook] Deploy skipped — ${owner}/${repo} not configured`);
    return;
  }
  if (ref !== `refs/heads/${app.config.targetBranch}`) {
    console.log(`[webhook] Skipping non-target branch: ${ref} (target: ${app.config.targetBranch})`);
    return;
  }

  // Use the app name stored at connect time — it's randomly generated now, not
  // re-derivable from owner/repo, so it must come from the DB row.
  const appName = app.caproverAppName;
  console.log(`[webhook] Push to ${owner}/${repo} @ ${sha.slice(0, 7)} → app: ${appName}`);

  const envVars = await prisma.envVar.findMany({ where: { appConfigId: app.config.id } });

  const deploy = await prisma.deploy.create({
    data: { appId: app.id, commitSha: sha, status: "queued" },
  });

  console.log(`[webhook] Deploy #${deploy.id} queued for ${appName}`);

  // Fire-and-forget — respond to GitHub quickly, deploy runs in background
  deployApp({
    owner,
    repo,
    sha,
    installationId,
    appName,
    buildPack: app.config.buildPack,
    envVars,
    appId: app.id,
    deployId: deploy.id,
  })
    .then(() => console.log(`[webhook] Deploy #${deploy.id} succeeded: ${appName}`))
    .catch((error) => console.error(`[webhook] Deploy #${deploy.id} failed: ${appName} —`, error.message));
}

async function handleInstallation(payload) {
  const { action, installation, sender } = payload;
  const username = sender.login.toLowerCase();

  if (action === "created") {
    // Link to an account if this GitHub user has already signed in to zycloud.
    const identity = await prisma.authIdentity.findFirst({
      where: { provider: "GITHUB", providerUsername: username },
    });
    await prisma.sourceConnection.upsert({
      where: { provider_externalId: { provider: "GITHUB", externalId: String(installation.id) } },
      create: {
        provider: "GITHUB",
        externalId: String(installation.id),
        ownerLogin: username,
        ...(identity ? { accountId: identity.accountId } : {}),
      },
      update: {},
    });
    console.log(`[webhook] App installed by: ${username}`);
  } else if (action === "deleted") {
    await prisma.sourceConnection.deleteMany({
      where: { provider: "GITHUB", externalId: String(installation.id) },
    });
    console.log(`[webhook] App uninstalled by: ${username}`);
  }
}

function handleInstallationRepos(payload) {
  console.log(
    `[webhook] Installation repos changed: action=${payload.action} ` +
    `added=${payload.repositories_added?.length ?? 0} ` +
    `removed=${payload.repositories_removed?.length ?? 0}`
  );
}
