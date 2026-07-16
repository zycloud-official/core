import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { prisma } from "../src/db.js";
import { cleanDb } from "./helpers.js";

vi.mock("../src/integrations/github/client.js", () => ({
  downloadTarball: vi.fn(),
  githubApp: {},
}));

vi.mock("../src/caprover.js", () => ({
  getAppDefinition: vi.fn(),
  createApp: vi.fn().mockResolvedValue(undefined),
  uploadTarball: vi.fn().mockResolvedValue({}),
  enableSsl: vi.fn().mockResolvedValue(undefined),
  updateAppDefinition: vi.fn().mockResolvedValue(undefined),
}));

const { deployApp } = await import("../src/deploy.js");
const { downloadTarball } = await import("../src/integrations/github/client.js");
const { getAppDefinition, createApp, uploadTarball, enableSsl, updateAppDefinition } =
  await import("../src/caprover.js");

// Creates a minimal .tar.gz mimicking GitHub's tarball format
// (files nested inside a top-level "owner-repo-sha/" directory).
async function makeTarball(files = {}) {
  const srcDir = await mkdtemp(join(tmpdir(), "tarball-src-"));
  const topDir = join(srcDir, "owner-repo-abc1234");
  await mkdir(topDir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(topDir, name), content);
  }
  const tarPath = join(srcDir, "test.tar.gz");
  await tar.create({ gzip: true, file: tarPath, cwd: srcDir }, ["owner-repo-abc1234"]);
  const { readFile, rm } = await import("node:fs/promises");
  const buffer = await readFile(tarPath);
  await rm(srcDir, { recursive: true, force: true });
  return buffer;
}

// Seeds a fresh app + deploy row and returns params ready for deployApp().
async function seed() {
  const testApp = await prisma.app.create({
    data: {
      githubRepo: "alice/testrepo",
      caproverAppName: "alice-testrepo",
      previewUrl: "https://alice-testrepo.zycloud.space",
    },
  });
  const testDeploy = await prisma.deploy.create({
    data: { appId: testApp.id, commitSha: "abc123", status: "queued" },
  });
  return {
    owner: "alice",
    repo: "testrepo",
    sha: "abc123",
    installationId: 42,
    appName: "alice-testrepo",
    buildPack: "static",
    envVars: [],
    appId: testApp.id,
    deployId: testDeploy.id,
    deployDbId: testDeploy.id,
  };
}

describe("deployApp — CapRover app lifecycle", () => {
  it("creates the app and enables SSL on first deploy", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(await makeTarball({ "index.html": "<html/>" }));
    getAppDefinition.mockResolvedValue(null); // app doesn't exist yet

    await deployApp(params);

    expect(createApp).toHaveBeenCalledWith("alice-testrepo");
    expect(enableSsl).toHaveBeenCalledWith("alice-testrepo");
  });

  it("enables SSL on existing app where SSL was never set up", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(await makeTarball({ "index.html": "<html/>" }));
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: false });

    await deployApp(params);

    expect(createApp).not.toHaveBeenCalled(); // app already exists
    expect(enableSsl).toHaveBeenCalledWith("alice-testrepo"); // SSL still applied
  });

  it("skips createApp and enableSsl when app already has SSL", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(await makeTarball({ "index.html": "<html/>" }));
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: true });

    await deployApp(params);

    expect(createApp).not.toHaveBeenCalled();
    expect(enableSsl).not.toHaveBeenCalled();
  });
});

describe("deployApp — captain-definition injection", () => {
  it("injects a captain-definition for the chosen buildPack when the repo has none", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(
      await makeTarball({ "package.json": JSON.stringify({ dependencies: { vite: "^5.0.0" } }) })
    );
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: true });

    await deployApp({ ...params, buildPack: "vite" });

    expect(uploadTarball).toHaveBeenCalledOnce();
    const [, tarBuffer] = uploadTarball.mock.calls[0];
    expect(tarBuffer).toBeInstanceOf(Buffer);
    // vite's containerHttpPort (80) should be what gets pushed to CapRover.
    expect(updateAppDefinition).toHaveBeenCalledWith(
      "alice-testrepo",
      expect.objectContaining({ containerHttpPort: 80 })
    );
  });

  it("throws for an unknown buildPack instead of silently deploying without one", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(await makeTarball({ "index.html": "<html/>" }));
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: true });

    await expect(deployApp({ ...params, buildPack: "not-a-real-buildpack" })).rejects.toThrow(
      "Unknown buildPack"
    );
  });

  it("leaves an existing captain-definition untouched", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    const existingDef = JSON.stringify({ schemaVersion: 2, dockerfileLines: ["FROM nginx"] });
    downloadTarball.mockResolvedValue(await makeTarball({ "captain-definition": existingDef }));
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: true });

    await deployApp(params);

    expect(uploadTarball).toHaveBeenCalledOnce();
  });
});

describe("deployApp — env vars", () => {
  it("decrypts env vars just before pushing them to CapRover", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(await makeTarball({ "index.html": "<html/>" }));
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: true });

    const { encryptSecret } = await import("../src/crypto/secrets.js");
    await deployApp({
      ...params,
      envVars: [{ key: "NODE_ENV", value: encryptSecret("production") }],
    });

    expect(updateAppDefinition).toHaveBeenCalledWith(
      "alice-testrepo",
      expect.objectContaining({ envVars: [{ key: "NODE_ENV", value: "production" }] })
    );
  });
});

describe("deployApp — deploy status", () => {
  it("sets status to success after a clean deploy", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockResolvedValue(await makeTarball({ "index.html": "<html/>" }));
    getAppDefinition.mockResolvedValue({ appName: "alice-testrepo", hasDefaultSubDomainSsl: true });

    await deployApp(params);

    const deploy = await prisma.deploy.findUnique({ where: { id: params.deployDbId } });
    expect(deploy?.status).toBe("success");
  });

  it("sets status to failed when an error occurs", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();
    downloadTarball.mockRejectedValue(new Error("network timeout"));

    await expect(deployApp(params)).rejects.toThrow("network timeout");

    const deploy = await prisma.deploy.findUnique({ where: { id: params.deployDbId } });
    expect(deploy?.status).toBe("failed");
    expect(deploy?.log).toContain("network timeout");
  });
});

describe("deployApp — temp file cleanup", () => {
  it("removes the temp directory even when the deploy fails", async () => {
    await cleanDb();
    vi.clearAllMocks();
    const params = await seed();

    const before = (await readdir(tmpdir())).filter((n) => n.startsWith("zycloud-"));
    downloadTarball.mockRejectedValue(new Error("boom"));

    await expect(deployApp(params)).rejects.toThrow("boom");

    const after = (await readdir(tmpdir())).filter((n) => n.startsWith("zycloud-"));
    expect(after.length).toBe(before.length);
  });
});
