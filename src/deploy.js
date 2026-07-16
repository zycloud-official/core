import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
// SEAM: source fetch is the only provider-specific step in this pipeline. Today
// it's GitHub-only; when a second provider (GitLab, …) lands, dispatch on the
// app's SourceConnection.provider to the right downloadTarball implementation
// instead of importing GitHub's directly. The rest of the pipeline is agnostic.
import { downloadTarball } from "./integrations/github/client.js";
import { buildPacks } from "./detect.js";
import {
  getAppDefinition,
  createApp,
  uploadTarball,
  enableSsl,
  updateAppDefinition,
} from "./caprover.js";
import { decryptSecret } from "./crypto/secrets.js";
import { prisma } from "./db.js";

const log = (deployId, msg) =>
  console.log(`[deploy #${deployId}] ${msg}`);

const err = (deployId, msg, error) =>
  console.error(`[deploy #${deployId}] ${msg}`, error);

export async function deployApp({
  owner,
  repo,
  sha,
  installationId,
  appName,
  buildPack,
  envVars = [],
  appId,
  deployId,
}) {
  const setStatus = (status, logMsg) =>
    prisma.deploy.update({
      where: { id: deployId },
      data: { status, log: logMsg },
    });

  log(deployId, `Starting deploy for ${owner}/${repo} @ ${sha.slice(0, 7)}`);
  await setStatus("building", null);

  let tmpDir;
  const t0 = Date.now();

  try {
    tmpDir = await mkdtemp(join(tmpdir(), "zycloud-"));
    log(deployId, `Temp dir: ${tmpDir}`);

    const rawTarball = join(tmpDir, "raw.tar.gz");
    const extractDir = join(tmpDir, "src");
    const packedTarball = join(tmpDir, "deploy.tar.gz");

    // 1. Download tarball from GitHub
    log(deployId, `Downloading tarball from GitHub (installationId: ${installationId})...`);
    const tarballBuffer = await downloadTarball(owner, repo, sha, installationId);
    await writeFile(rawTarball, tarballBuffer);
    log(deployId, `Downloaded ${(tarballBuffer.length / 1024).toFixed(1)} KB`);

    // 2. Extract — strip the top-level directory GitHub adds (e.g. owner-repo-sha/)
    log(deployId, "Extracting tarball...");
    await mkdir(extractDir);
    await tar.extract({ file: rawTarball, cwd: extractDir, strip: 1, strict: false });
    log(deployId, "Extracted successfully");

    // 3. Inject captain-definition if the repo doesn't have one
    const captainDefPath = join(extractDir, "captain-definition");
    let hasCaptainDef = false;
    try {
      await access(captainDefPath, constants.F_OK);
      hasCaptainDef = true;
    } catch {}

    const pack = buildPacks[buildPack];
    if (!pack) {
      throw new Error(`Unknown buildPack: ${buildPack}`);
    }

    if (hasCaptainDef) {
      log(deployId, "Found existing captain-definition — using as-is");
    } else {
      const captainDef = pack.captainDef(extractDir);
      await writeFile(captainDefPath, JSON.stringify(captainDef, null, 2));
      log(deployId, `Injected captain-definition for buildPack: ${buildPack}`);
    }

    // 4. Repack into a clean tarball
    log(deployId, "Repacking tarball...");
    await tar.create({ gzip: true, file: packedTarball, cwd: extractDir }, ["."]);
    const deployBuffer = await readFile(packedTarball);
    log(deployId, `Repacked: ${(deployBuffer.length / 1024).toFixed(1)} KB`);

    // 5. Create CapRover app if it doesn't exist yet
    const existingApp = await getAppDefinition(appName);
    if (!existingApp) {
      log(deployId, `Creating new CapRover app: ${appName}`);
      await createApp(appName);
      log(deployId, "App created");
    } else {
      log(deployId, `Updating existing CapRover app: ${appName}`);
    }

    // 6. Upload tarball to CapRover
    log(deployId, "Uploading tarball to CapRover...");
    await uploadTarball(appName, deployBuffer);
    log(deployId, "Upload complete — CapRover is building the image");

    // 7. Enable HTTPS if not already enabled.
    // Check the live SSL status rather than relying on isNew — a previously
    // failed deploy leaves the app shell in CapRover with SSL never enabled.
    const sslEnabled = existingApp?.hasDefaultSubDomainSsl ?? false;
    if (!sslEnabled) {
      log(deployId, "Enabling HTTPS...");
      await enableSsl(appName);
      log(deployId, "HTTPS enabled");
    }

    // 8. Push the buildpack's port + env vars on every deploy (not just the
    // first) — env vars can be added later, and the port depends on buildPack.
    log(deployId, `Updating app definition (port ${pack.containerHttpPort}, ${envVars.length} env var(s))...`);
    await updateAppDefinition(appName, {
      containerHttpPort: pack.containerHttpPort,
      envVars: envVars.map((v) => ({ key: v.key, value: decryptSecret(v.value) })),
    });
    log(deployId, "App definition updated");

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const previewUrl = `https://${appName}.zycloud.space`;
    log(deployId, `Done in ${elapsed}s → ${previewUrl}`);

    await setStatus("success", `Deployed ${sha.slice(0, 7)} → ${previewUrl}`);
  } catch (error) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    err(deployId, `Failed after ${elapsed}s: ${error.message}`, error);
    await setStatus("failed", error.message);
    throw error;
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      log(deployId, "Temp dir cleaned up");
    }
  }
}
