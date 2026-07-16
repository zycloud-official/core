import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { detectFramework } from "../src/detect.js";

// Opt-in: these tests `docker build` + run real images, which is slow and needs
// Docker. Enable with `RUN_DOCKER_BUILDS=1 yarn test`. Skipped otherwise so the
// default suite stays fast and Docker-free.
const ENABLED = process.env.RUN_DOCKER_BUILDS === "1";
const d = ENABLED ? describe : describe.skip;

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const BUILD_TIMEOUT = 600_000; // base-image pulls + installs can take minutes

// The port each template's app listens on (matches the EXPOSE in detect.js).
const CASES = [
  { name: "static", port: 80 },
  { name: "dockerfile", port: 80 },
  { name: "node", port: 3000 },
  { name: "vite", port: 80 },
  { name: "python", port: 5000 },
  { name: "python-fastapi", port: 8000 },
  { name: "python-django", port: 8000 },
  { name: "nextjs", port: 3000 },
];

const images = [];
const containers = [];

function sh(args, opts = {}) {
  return execFileSync("docker", args, { encoding: "utf8", ...opts }).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reproduce what CapRover does with a captain-definition: write its
 * dockerfileLines to a Dockerfile in the build context. For the `dockerfile`
 * framework, captainDef points at the repo's own committed Dockerfile (no
 * dockerfileLines to write) — use it as-is.
 */
function prepareBuildContext(name) {
  const buildDir = mkdtempSync(join(tmpdir(), `zycloud-build-${name}-`));
  cpSync(join(FIXTURES, name), buildDir, { recursive: true });

  const { framework, captainDef } = detectFramework(buildDir);
  if (captainDef?.dockerfileLines) {
    writeFileSync(
      join(buildDir, "Dockerfile"),
      captainDef.dockerfileLines.join("\n") + "\n"
    );
  }
  return { buildDir, framework };
}

async function probe(hostPort) {
  // Poll until the container is serving or we give up.
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/`);
      const body = await res.text();
      return { status: res.status, body };
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`No response from container on port ${hostPort} after 30s`);
}

d("captain-definition builds and serves", () => {
  afterAll(() => {
    for (const c of containers) {
      try {
        sh(["rm", "-f", c], { stdio: "pipe" });
      } catch {}
    }
    for (const img of images) {
      try {
        sh(["rmi", "-f", img], { stdio: "pipe" });
      } catch {}
    }
  });

  for (const { name, port } of CASES) {
    it(
      `${name}: image builds, runs, and responds on :${port}`,
      async () => {
        const tag = `zycloud-fixture-${name}:test`;
        const { buildDir } = prepareBuildContext(name);

        try {
          sh(["build", "-t", tag, buildDir], { stdio: "pipe" });
          images.push(tag);

          const cid = sh(["run", "-d", "-p", `127.0.0.1::${port}`, tag]);
          containers.push(cid);

          // `docker port` reports the host mapping, e.g. "127.0.0.1:49153".
          const mapping = sh(["port", cid, `${port}/tcp`]);
          const hostPort = mapping.split(":").pop().trim();

          const { status, body } = await probe(hostPort);
          expect(status).toBeLessThan(500);
          expect(body).toContain(`hello from ${name}`);
        } finally {
          rmSync(buildDir, { recursive: true, force: true });
        }
      },
      BUILD_TIMEOUT
    );
  }
});
